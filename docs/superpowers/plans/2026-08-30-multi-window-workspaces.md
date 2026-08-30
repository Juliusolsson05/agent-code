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
somewhere the user can find them. The surviving window takes over the closed
window's workspace: its tabs are appended, its sessions merged, and every one
of them shows up in that window's Dispatch.

**The survivor performs the merge, not main.** Main deliberately treats a
window's workspace payload as opaque (§4), and this merge reasons about tabs,
tile leaves, detached records, pins, and drafts. Implementing it in main would
be a second opinion about session ownership, free to disagree with
`sessionOwnership.ts` — the exact failure that module's header warns about. So
main hands the survivor the closed window's last persisted slice over
`workspace:adopt`, and `adoptWorkspace()` (a pure function in the renderer)
does the merge.

**Adopted tabs keep their tile trees.** The first design here converted every
tile leaf into a `DetachedSessionRecord`, on the theory that "they show up in
Dispatch" meant "they become Dispatch rows". Two findings killed that:

1. It is not representable. `Tab.root` is a `TileNode` whose only terminal form
   is `{ type: 'leaf', sessionId }` — a tab with no panes cannot exist, so
   flattening every leaf leaves the adopted tabs with no valid root.
2. It buys nothing. `buildDispatchGroups` (`dispatchSelectors.ts`) already lists
   **both** grid-placed and detached sessions for a tab, so an adopted agent
   appears in the survivor's Dispatch either way.

Keeping the tree therefore costs nothing and preserves the arrangement the user
built.

**Tabs travel with their sessions.** `collectOwnedSessionIds` drops a detached
record whose `projectTabId` names no tab — deliberately: "a missing parent means
there is no surface from which the agent can be found or managed." Handing the
survivor bare records would delete them on its very next autosave. Carrying the
tab keeps every `projectTabId` valid by construction, with nothing rewritten.
The `projectTabIndex` display ordinal IS re-derived, because the adopted tabs
are appended after the survivor's own and a stale index would label the Dispatch
rows with the wrong project letter.

**Adopted sessions are seeded from a backend snapshot, not recovered.**
`recoverSession` exists to reconcile a persisted id with a backend that may or
may not still exist after an app restart; it can adopt, spawn, or fail, and
takes a generation fence and a 30-second deadline to do it. Here every backend
is alive, healthy, and already owned by main — the only thing missing is this
renderer's view. So adoption seeds `emptyRuntime()` +
`seedResumedRuntimeFields()` and calls `loadInitialHistoryForSession`, the same
helpers bootstrap uses, and skips recovery entirely.

**An id collision refuses the whole adoption.** Both id spaces are
`randomUUID()`, so a collision means the file was hand-edited or something is
already wrong, and "merge the parts that fit" is guessing. Dropping a colliding
tab would strand its sessions: alive in `SessionManager`, owned by no window,
invisible and unkillable from the UI.

**Deletion is confirmed, never assumed.** Main drops the closed window's slice
only when the survivor calls `window:adoption-complete`. Until the adopting
renderer's next autosave lands, that slice is the only durable record of those
sessions. A renderer that refused the merge, could not parse it, or died
mid-handoff simply never confirms, and the workspace comes back as its own
window on the next launch.

**Ordering.** Session ownership transfers *before* the survivor is told, so an
event emitted during the handoff already routes to the window that will display
it. And the whole handoff waits one turn of the event loop after `closed`,
because the closing renderer's `beforeunload` autosave is already queued as an
IPC message — reading the slice in the same tick would compose the bequest from
the previous save and lose the last 400 ms of work.

**Which window inherits:** the last-focused surviving window.

**Focus does not move.** Another window closing is not a request to navigate;
the adopted tabs appear without stealing the user's place.

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
is `feat/multi-window`. What actually shipped, in order:

1. **Registry, no behavior change.** Split `mainWindow.ts` into
   `windowRegistry.ts` + `appWindow.ts` and reclassify all 30 send sites (§5),
   still creating exactly one window. The three bridges that carried
   "must be target-aware" comments were done here rather than last: they are
   send sites like any other, and leaving them ambiguous through four more
   commits would have meant reasoning about routing twice.
2. **Ownership map.** `sessionId → WindowId` claimed at id-mint time inside
   `spawn()`, released on explicit kill.
3. **Persistence v2.** File format, migration, per-window load/save merge, and
   startup restoring every persisted window. Display validation landed here too,
   since restoring N windows without it is what strands one off-screen.
4. **New Window.** File-menu item, palette command, ⌘⇧N, `window:new`.
   Geometry became durable on move/resize in the same commit — a window you drag
   and never touch again otherwise never persists its position.
5. **Bequest.** `adoptWorkspace`, `workspace:adopt`, confirmed deletion,
   quit-vs-close.

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

- `adoptWorkspace.test.ts` — adopted detached records are still *owned* by the
  survivor's own `collectOwnedSessionIds` (the assertion that proves tabs had to
  travel with their sessions); tile arrangement survives; pins, drafts, and
  buried panes survive; the Dispatch project ordinal is re-derived; an id
  collision refuses the whole adoption.

**Routing:**

- `windowRegistry.routing.test.ts` — session events reach only the owner;
  unowned ids broadcast; ownership transfers on adoption before any event is
  emitted; ownership survives a natural exit and ends on an explicit kill.
- `windowGeometry.test.ts` — bounds on a detached display are rejected, a
  window parked half off the edge is kept, and a sliver too small to grab is
  not. The display-change failure only reproduces with a monitor unplugged,
  which no deterministic suite can stage, so the predicate is split out and
  tested against work-area rectangles directly.
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
