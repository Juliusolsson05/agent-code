# Multiple application windows

> Fixes #688

## Outcome

Agent Code can open more than one window. Each window is its own workspace —
its own tabs, panes, Dispatch, and agents — inside the **one existing primary
process**. A second window can be dragged to a second monitor, filled with its
own agents, and it comes back on the same display after a relaunch.

Closing a window is not destructive: its agents stay alive in `SessionManager`
and are adopted as detached (Dispatch) sessions by a surviving window, under
their original project tab.

## The problem

The product is built for running many agents at once, and then confines all of
them to a single window. On a two-monitor desk the second display is unusable.
Every editor this app is compared to treats "another window over there" as
table stakes; for an app whose entire premise is parallel agent work, the gap
costs more here than it does in VS Code.

The single-window assumption is not incidental — it is written down in four
places, three of which explicitly anticipate this change:

- `src/main/window/mainWindow.ts:11` — "If we ever add a second window, this
  module grows a per-role registry; for now the single-window assumption is
  baked in and explicit." One module-scoped `BrowserWindow`; `sendToMainWindow()`
  is the only outbound IPC seam, with 30 non-test call sites.
- `src/main/workflows/WorkflowBridge.ts:494` — "a future multi-window product
  must make WorkflowBridgeSender target-aware before sharing this loop across
  windows."
- `src/main/orchestration/OrchestrationBridge.ts:455` — names "future
  multi-window behavior" as one of the workspace concerns that lives in the
  renderer.
- `src/main/menu/appMenu.ts:136` — a bare `{ role: 'windowMenu' }`. There is no
  New Window anywhere in the app.

`docs/archive/issue-investigations/147-multi-instance-policy.md` already
settled the shape this must take, and that conclusion is adopted wholesale
here: **more windows in the one main process, never more main processes.** Two
Electron mains would put two writers on `~/.config/agent-code` with no merge
semantics and could resume the same provider session twice. Both guards that
enforce this (`app.requestSingleInstanceLock()` and the advisory state lock at
`~/.config/agent-code/agent-code.process-lock.json`) stay exactly as they are.
This change is what that doc calls the "real architecture change": replacing the
`mainWindow` singleton with a registry.

### The hazard that shapes the whole design

`useAutoSave.ts` does not merely serialize the workspace. It **prunes**:
`pruneSessionOwnership` drops any row in `sessions` it cannot trace to a tile
leaf, a detached record, or a buried pane, and `repairPersistedTabs` rewrites
tile trees to match. The module header states the intent plainly — "metadata
with no owner cannot make itself durable" — and it exists because orphan
metadata once got respawned into invisible backend processes on every launch.

That guard is correct for one writer and catastrophic for two. If both windows
serialize *the whole workspace*, each one classifies the other's agents as
unowned garbage and deletes them from `workspace.json` — every 400 ms, in both
directions, with the file's only writer being the thing doing the deleting.

So per-window save slices are a **correctness requirement**, not an
organizational preference, and the same is true of the routing work: a session
event delivered to a window that does not own the session does not get ignored,
it *materializes state* (`prev[sessionId] ?? emptyRuntime()` appears eleven
times in `useIpcSubscriptions.ts`). Both of those get regression tests that can
actually fail.

## What this does NOT change

- **One primary process.** Both locks stay. `docs/archive/.../147` remains policy.
- **Settings stay global.** `localStorage`-backed `useAppStore` settings are a
  user preference, not workspace layout. Both windows share them.
- **The rendering pipeline.** `session-runtime → rendering → features/feed` is
  untouched. A window is a second *consumer* of the same pipeline, exactly as
  the remote phone client already is.
- **Session ownership semantics inside a window.** `sessionOwnership.ts` keeps
  its two sets and all of their reasoning. Windows partition the input to those
  functions; they do not change the functions.
- **No agent/tab moving between windows.** Out of scope (issue #688). Detach in
  one window, reattach in the other, already works and is the documented
  workaround.
- **No per-window provider, MCP, or worktree services.** Every disk-owning
  service in `startApp()` stays a process singleton.

## Design

### 1. `mainWindow.ts` becomes a window registry

`src/main/window/mainWindow.ts` is 400 lines that mix three jobs: window
construction, outbound IPC, and the outbound-IPC diagnostic breadcrumb ring.
Only the first is per-window. It splits:

- **`src/main/window/appWindow.ts`** — `createAppWindow(options)`. The current
  `createMainWindow()` body, parameterized by `windowId` and optional persisted
  `bounds`. Everything it installs today — the traffic-light inset push, the
  zoom clamp and `before-input-event` handler, `setWindowOpenHandler`,
  `will-navigate`, the `will-prevent-unload` unsaved-editor dialog — becomes
  per-window and keeps its existing comments verbatim. Each of those was a real
  bug fix and none of them was ever about *the* window; they were about *a*
  window.
- **`src/main/window/windowRegistry.ts`** — the registry plus routing, and the
  new owner of the breadcrumb ring (transport diagnostics are process-wide, not
  window-scoped, and `getOutboundIpcDiagnostics()` is consumed by the freeze
  logger which reports on the process).

Registry surface:

```ts
type WindowId = string            // durable uuid, persisted in workspace.json

createAppWindow(opts?: { windowId?: WindowId; bounds?: WindowBounds }): WindowId
closeAppWindow(id: WindowId): void
getBrowserWindow(id: WindowId): BrowserWindow | null
windowIdFor(webContents: WebContents): WindowId | null
focusedWindowId(): WindowId | null        // falls back to last-focused
listWindowIds(): WindowId[]               // creation order

broadcastToWindows(channel, ...args): void
sendToWindow(id, channel, ...args): void
sendToFocusedWindow(channel, ...args): void
sendToSessionWindow(sessionId, channel, ...args): void
```

`sendToMainWindow` is deleted rather than aliased. An alias would let a new
call site keep the ambiguity the registry exists to remove, and the whole point
of this change is that "send to the window" is no longer a well-formed thought.
Each of the 30 call sites gets classified by hand — see §5.

`focusMainWindow()` (called from the `second-instance` handler,
`src/main/index.ts:231`) becomes "focus the last-focused window, or the first
one if none has been focused yet."

### 2. Session ownership is established at spawn, not at save

Routing needs a `sessionId → WindowId` map. The tempting source is
`workspace:save`, which already calls
`manager.acknowledgePersistedSessionOwnership()` — but that runs on a 400 ms
debounce, so a freshly spawned session would have no owner for the entire
window in which its first events arrive. That is exactly the window where
`session:started`, the first screen snapshot, and the first semantic events
land.

Instead the registry learns ownership from **the request that created the
session**. `session:spawn` (`src/main/ipc/session.ts:41`) and `session:recover`
(`:50`) both receive `_evt.sender`; `windowIdFor(sender)` gives the owner
synchronously, before the manager emits anything. Ownership is released on
`session:kill` / `session:kill-owned` and on the bequest path (§6).

This also means ownership is exact rather than inferred: the window that asked
for the session is the window that renders it, by construction.

**Ownership is claimed from inside `spawn()`, at id-mint time.** `spawn()`
mints the id itself and then *awaits the provider start* — during which the
provider emits `started`, the first screen snapshot, and its first semantic
events. A caller claiming ownership from the resolved result would therefore
have an unrouted hole exactly where a new pane's first paint lives. `spawn`
takes an `onSessionIdMinted` callback instead, called synchronously with the
fresh id before anything can emit for it. It is a callback rather than an
`ownerWindowId` option so `SessionManager` stays ignorant of windows.

`session:recover` needs no hook: the renderer supplies the durable id it is
restoring, so the claim happens before the call.

Ownership is released only on an explicit `session:kill` / `session:kill-owned`,
**not** when a session exits on its own. An exited pane is still on screen,
still owned, and can be reloaded in place.

**Unknown owner ⇒ broadcast, and no renderer-side guard.** Dropping would
silently freeze a pane (P6: a row that survives is diagnosable, one that
vanishes is not), so the fallback broadcasts.

The obvious belt to that suspenders — "renderer ignores sessions it does not
own" — was designed and then rejected, and the reason is worth recording
because it looks like an oversight otherwise. **The renderer cannot distinguish
"not mine" from "mine, but not registered yet."** A pane's first events
legitimately precede the `session:spawn` IPC response; that is the entire
reason ownership is claimed from inside `spawn()`. The renderer accumulates
those events under an id it has never seen (`prev[sessionId] ?? emptyRuntime()`).
A guard strict enough to reject a foreign session would also reject the first
frames of every new pane in its own window.

So the fallback is made *rare by construction* (ownership exists from mint until
explicit disposal) and *visible* (a `window.route.unowned-session` breadcrumb in
the outbound diagnostic ring, metadata-only), rather than made harmless by a
guard that cannot exist.

### 3. `workspace.json` grows a window dimension

Today the file is `{ workspace: PersistedWorkspace }` — one envelope, one
workspace, written whole by the single renderer (`useAutoSave.ts:141`).

```jsonc
{
  "version": 2,
  "windows": [
    {
      "windowId": "…uuid…",
      "bounds": { "x": 0, "y": 0, "width": 1400, "height": 900 },
      "displayId": 69732928,          // Electron display id, best-effort
      "fullScreen": false,
      "workspace": { /* today's PersistedWorkspace, unchanged */ }
    }
  ]
}
```

`PersistedWorkspace` itself does not change. That matters: `rehydrate.ts` is 874
lines of hard-won restore logic and none of it should learn about windows. It
keeps receiving exactly the shape it receives today; the only difference is
*which* slice it is handed.

**Migration.** A v1 file (no `version`, top-level `workspace`) is read as a
single window: `windows[0]` with a freshly minted `windowId` and no bounds.
This happens in main, in the load path, so a renderer never sees the legacy
shape. Migration is one pure function with its own test over a real captured
`workspace.json`; the fixture is redacted the same way rendering fixtures are.

**Why the window list lives in one file rather than one file per window.**
Adoption (§6) is a *merge across two slices* and the quit path must write both
atomically-ish; splitting into `workspace.<windowId>.json` would turn one
rename into an N-file transaction with no barrier, and would leave orphan files
behind whenever a window id is retired. The existing single-file atomic
temp+rename in `src/main/ipc/workspace.ts` already has the queueing and
ordering reasoning worked out (its `saveTail` comment explains why reads join
the same tail); extending it beats replacing it.

### 4. Saves become per-window merges

`workspace:save` currently takes opaque bytes and, apart from one narrow parse
for ownership acknowledgement, refuses to interpret them ("The renderer is the
source of truth for the tile tree. Main just reads / writes bytes").

That refusal cannot survive multi-window, and the reason is physical rather
than stylistic: **window 1 cannot serialize window 2's slice, because it has
never seen it.** Something has to compose the file from N independent authors,
and main is the only party that can. So the contract narrows precisely:

- `workspace:save(json)` still receives one renderer's `{ workspace }` payload,
  unchanged and still uninterpreted by main.
- Main resolves `windowIdFor(evt.sender)`, then writes that payload into
  `windows[<id>].workspace`, leaving every other window's slice byte-identical
  to what that window last wrote.
- The whole read-modify-write stays on the existing `saveTail`, so two windows
  saving concurrently serialize instead of racing.
- `acknowledgePersistedSessionOwnership` keeps working, but is now called with
  the union of every window's session keys, since it answers a
  process-wide question ("which local ids has *some* renderer committed").

Main still does not understand tabs, panes, or ownership. It understands
exactly one new thing: which window an opaque blob belongs to.

`workspace:load` mirrors it — resolve the sender's window id, return that
window's slice (or `null`, which the renderer already handles as "fresh
install", producing the default single-agent bootstrap).

**The prune hazard is closed by construction**: a window's save only ever
rewrites its own subtree, so window 1's pruning verdict can never reach window
2's rows. §"Tests" pins this with a test that fails on the naive implementation.

### 5. Every outbound send is reclassified

The 30 `sendToMainWindow` call sites fall into four groups. This classification
is the core of the change and is worth stating explicitly, because "which
window should hear this?" has a different answer per channel and no default is
right for all of them.

**Session-routed → `sendToSessionWindow(payload.sessionId, …)`.** Every payload
already carries a `sessionId` (`forwarder.ts:19` says so as the reason the
renderer can route to the right tile):

`session:started`, `session:screen`, `session:process-state`,
`session:semantic-event`, `session:jsonl-entries`, `session:jsonl-error`,
`session:conditions`, `session:exit`, `session:input-readiness`,
`session:transcript-diagnostic`, `session:sub-agents`, `session:terminal-data`,
`session:agent-pty-data`, `record-session:started`, `record-session:stopping`.

This group is also where the multi-window *performance* argument lives: without
routing, every window would decode the full firehose of every other window's
agents. The repo has already paid for that class of mistake once
(`docs/rendering/…` freeze investigations, the 60 Hz screen-snapshot churn).

**Broadcast → `broadcastToWindows`.** Process-wide state every window renders:
`ai-workspace:changed`, `cli-updates:state`, `caffeinate:state-changed`,
`remote:status-changed`, `lsp:diagnostics` (diagnostics are keyed by file and
consumed by whichever window has that file open; both may).

**Focused window → `sendToFocusedWindow`.** User-gesture-originated, where "the
window I am looking at" is the only sensible target: `menu:command`,
`dictation:hotkey-down`, `dictation:hotkey-up`,
`ai-workspace:open-request`.

`dictation:stream-transcript` is a reply to an in-flight dictation the renderer
itself started, so it routes to the window that started it — the dictation
controller records the originating `WindowId` when the stream opens, rather
than guessing at delivery time (the user can focus another window mid-dictation
and the words must still land in the composer they are dictating into).

**Bridge requests → the window owning the caller.** All three MCP bridges carry
a caller identity in their request payloads, so no new plumbing is needed:

- `OrchestrationBridge` — `parentSessionId` on every request variant
  (`src/mcp/shared/orchestrationTypes.ts:10`).
- `AgentManagementBridge` — `callerSessionId` on `AgentManagementRequestBase`
  (`src/mcp/shared/agentManagementTypes.ts:97`).
- `WorkflowBridge` — already tracks `rendererId` (a `webContents` id) per run
  interest and merely fails to use it when sending; `WorkflowBridgeSender` gains
  the target argument its own TODO comment asks for.

Unowned caller ⇒ reject the request with an explicit error rather than
broadcasting. These bridges are fail-closed by design (`AgentManagementBridge`'s
timeout comment spells out why), and answering an MCP mutation from the wrong
window's workspace model would be worse than answering it not at all.

### 6. Closing a window bequeaths its agents

Closing a window with live agents must not kill them, and the agents must land
somewhere the user can find them. `DetachedSessionRecord` is already exactly
that concept — "sessions can be live without grid placement" — and Dispatch
already renders it.

There is one constraint that dictates the mechanism.
`collectOwnedSessionIds()` drops a detached record whose `projectTabId` is not
among the window's tabs, deliberately: "a missing parent means there is no
surface from which the agent can be found or managed. Drop that closed
ownership island." So handing a surviving window bare detached records would
delete them on its very next autosave.

The bequest therefore moves **tabs and sessions together**:

1. The closing window's slice is transformed by a pure function
   `bequeathWindowWorkspace(closing, survivor)`:
   - every tile leaf in the closing slice becomes a `DetachedSessionRecord`
     with `surface: 'dispatch'` and its existing `projectTabId` / title / index;
   - the closing slice's tabs are appended to the survivor's tabs, with their
     roots reduced to the empty-project shape (they are now Dispatch-only
     projects);
   - `sessions`, `detachedSessions`, `buried`, `pinnedSessionIds`, and `drafts`
     are merged; `dispatchMode` and `tileTabs` of the closing window are dropped
     (they describe a layout that no longer exists);
   - session ids collide across windows only if the file was hand-edited — the
     function asserts disjointness and, on overlap, keeps the survivor's row and
     reports the dropped ids the same way autosave reports its own drops.
2. Main hands the merged slice to the survivor window over
   `workspace:adopt`, and the survivor merges it into its live store and saves.
3. The registry re-points `sessionId → survivorWindowId` for every adopted id
   **before** step 2, so events emitted during the handoff are already routed
   correctly.

Tab ids are preserved rather than merged into a same-project tab in the
survivor. Merging would require deriving a tab's project identity from its
sessions' `cwd` — `Tab` has no `cwd` field (`workspace/types.ts:48`) — and then
rewriting `projectTabId` across detached records, pins, and tiled lanes. Two
tabs for one project is honest and closable; inventing a tab-identity model to
avoid it is not in scope. This is called out in the plan so the next reader
knows it was a decision and not an oversight.

**Which window inherits:** the last-focused surviving window.

### 7. Quit is not close

Closing one window with others open is a bequest. Quitting is not — on quit
every window persists its own slice and all of them come back next launch. The
two paths must be distinguishable or a normal ⌘Q would collapse every workspace
into one window.

`app.on('before-quit')` sets a module flag; the per-window `close` handler
checks it and skips the bequest. The existing quit sequencing is delicate —
`WorkflowService.stop()` gating, `sessionShutdownGate`, the re-entrant
`app.quit()` — so the flag is *read* by the window close path and never
*written* by it.

Closing the **last** window while the app stays alive (macOS keeps the process
running; `src/main/index.ts:779` re-creates a window on `activate`) has no
survivor to bequeath to. Its slice simply stays in `workspace.json`, and the
next `activate` re-creates that window id and restores it. That is exactly
today's behavior, preserved.

### 8. Menu, command, keybinding

- `Window → New Window` as a real menu item. Window chrome is main's job — the
  same reasoning that keeps `{ role: 'close' }` native rather than dispatched
  (`appMenu.ts:98`).
- A renderer command `new-window` (`surface: 'app'`, title **New Window** —
  a stable noun phrase per `docs/command-style.md`) so it is discoverable in
  the palette and rebindable. It calls a new `window.api.newWindow()`.
- Default binding `Cmd+Shift+N`, `context: 'global'`
  (`features/command-keybindings/defaults.ts`). No existing default uses it;
  `npm run check:keybindings` proves that and will keep proving it.
- The menu item does **not** set an accelerator, per the file-level rule in
  `appMenu.ts`: a menu accelerator plus a renderer binding fires the command
  twice.
- `Window → Close Window` keeps `role: 'close'` and ⌘W.
- The zoom items call the focused window instead of the singleton.

### 9. What every window owns independently

Per window: tabs, panes, tile tabs, Dispatch state and lanes, pins, drafts,
detached and buried records, zoom level, bounds/display, traffic-light inset,
reader/spotlight/global-editor UI state.

Process-wide, unchanged: settings, prompt templates, themes, keybindings,
`SessionManager`, LSP, AI Workspace registry, worktree activity index, the MCP
hosts, the remote server, dictation, caffeinate, CLI-update orchestration,
performance/incident journals, both instance locks.

**Settings drift is accepted for v1 and stated here so it is not a surprise.**
Both windows share one `localStorage` origin, so a settings write in one window
lands on disk but is not observed by the other until it reloads. The failure is
benign and self-healing (last writer wins; both converge on reload), and a live
settings-sync channel is real work that this issue does not need. If it becomes
annoying, the fix is a `settings:changed` broadcast, not a change to any of the
above.

## Stages

Each stage is independently reviewable and leaves the app working. The branch
is `feat/multi-window`.

1. **Registry, no behavior change.** Split `mainWindow.ts` into
   `windowRegistry.ts` + `appWindow.ts`, reclassify all 30 send sites (§5),
   still creating exactly one window. Nothing user-visible; the whole diff is
   "who is this message for".
2. **Ownership map.** `sessionId → WindowId` at spawn/recover/kill, plus the
   renderer-side guard in `useIpcSubscriptions`. Still one window.
3. **Persistence v2.** File shape, migration, per-window load/save merge in
   `src/main/ipc/workspace.ts`. Still one window — the file gains a `windows`
   array of length 1.
4. **New Window.** Menu item, command, keybinding, `window.api.newWindow()`,
   fresh slice bootstrap. Two windows now genuinely work.
5. **Geometry.** Persist and restore bounds/display/fullScreen; clamp to a
   currently-attached display on restore (an unplugged monitor must not strand a
   window off-screen).
6. **Bequest.** `bequeathWindowWorkspace`, `workspace:adopt`, quit-vs-close flag.
7. **Bridges.** Target-aware `WorkflowBridgeSender`, orchestration and
   agent-management caller routing, deleting the three stale TODO comments that
   asked for exactly this.

## Tests

Following `docs/testing/standard.md`; suffix picks the tier.

**The hazard, first and non-negotiable:**

- `workspace.multiWindowSave.test.ts` (unit, main) — two windows save
  concurrently; assert each slice survives byte-for-byte and neither prunes the
  other. This test fails on the naive "renderer writes the whole file"
  implementation, which is the point.

**Persistence:**

- `workspaceFileMigration.test.ts` — a real v1 `workspace.json` (redacted
  fixture) migrates to v2 with tabs, sessions, detached, buried, pins, drafts,
  and `tileTabs` intact; a v2 file round-trips unchanged; an unknown future
  version fails loudly rather than silently resetting the workspace.
- `workspace:save` for an unregistered sender rejects rather than writing into a
  guessed slot.

**Bequest:**

- `bequeathWindowWorkspace.test.ts` — leaves become detached records that
  `collectOwnedSessionIds` still considers owned (this is the assertion that
  proves the tabs-move-with-sessions decision was necessary); pins and drafts
  survive; the closing window's `tileTabs`/`dispatchMode` are dropped;
  overlapping session ids keep the survivor's row and are reported.
- A quit does **not** bequeath: both slices persist separately.

**Routing:**

- `windowRegistry.routing.test.ts` — session events reach only the owner;
  unowned ids broadcast; ownership transfers on adoption before any event is
  emitted; ownership survives a natural exit and ends on an explicit kill.
- `sessionOwnershipClaim.test.ts` — the mint hook fires before `spawn()`
  resolves, so an event emitted mid-spawn is already routable. This is the
  assertion that would fail if someone "simplified" the callback away in favor
  of claiming from the resolved result.
- Bridge requests with an unowned caller reject with the fail-closed error
  rather than reaching a window.

**Contract:**

- `catalog.test.ts` already proves every native-menu id names a real command;
  `new-window` joins it.
- `npm run check:keybindings` covers the ⌘⇧N default.

**Not automated:** actually dragging a window to a second physical monitor and
relaunching. Electron cannot fake a second display in the deterministic suite,
and a mocked `screen` module would assert our own fake rather than macOS
behavior. Manual verification steps go in the PR body.

## Risks and open questions

- **Geometry restore on a changed display set.** Bounds are restored only if
  they intersect an attached display; otherwise the window is centered on the
  primary. Unplugging a monitor between runs is the common case, not the edge
  case.
- **`will-prevent-unload`** now runs per window. Two windows with unsaved editor
  files during quit produce two sequential dialogs. Acceptable; noted so it is
  not read as a bug.
- **Adoption during a hung survivor.** `workspace:adopt` is an IPC message to a
  renderer that could be busy. Sessions stay alive regardless (they live in
  main), so the failure mode is "agents are not visible until that window
  responds or restarts", not loss. The adopted ownership map is written in main
  first for exactly this reason.
- **Settings drift** — accepted, §9.
- The **remote phone client** is unaffected: it is session-scoped and reaches
  `SessionManager` directly, never through a window.
