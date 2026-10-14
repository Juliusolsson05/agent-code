# Sidekick: global agents in a right-docked panel, with their own index and Hermes built in

Refs #1493.
Branch `feat/sidekick-global-agent` · Worktree `.worktrees/sidekick-global-agent` · Base `origin/main` @ `d0c3df99` (the Hermes merge, fetched 2026-10-14)
Status: **building** (owner, 2026-10-14: "good, build the full thing out using agent code conventions"). Full build to an open PR (#1494, draft until done), then one review round; no merge without the owner's word. Decisions 1–8 ship at their defaults and stay **UNCONFIRMED** here and in the PR.

## Outcome

The owner keeps one conversation open beside the work, whatever project is open and in every window. That is usually their Hermes agent on the VPS, sometimes a Claude or Codex session started in `~/`. In Agent Code they:

1. press **⌘J**, and a **Sidekick** panel slides in at the right edge of the window, next to the lanes, which only get narrower;
2. press **⌘⇧J** (or the panel's header button) for the **Sidekick Picker**. It lists only their sidekicks and offers **New Sidekick ▸** with every enabled agent kind, Hermes first when a Hermes connection is signed in;
3. talk to the sidekick with the normal feed and composer (Hermes uses its chat surface). Keystrokes, paste and dictation go to the panel while it has focus and to the lanes otherwise, never to both;
4. close a project tab, close the window, or quit and relaunch, and the sidekick is still there, with the same conversation resumed by its native id;
5. open a second window and press **Open here** in its panel. The sidekick moves to that window without being killed or restarted, and the first window shows "Live in another window".

A sidekick never shows up in lanes, the Dispatch index, the bulk closes, adoption or the orchestration listings. It keeps its agent name, TLDR/Goal and wake/recovery behaviour, and stays resumable from Conversations.

## Evidence (verified, do not re-derive)

Read on `origin/main` `d0c3df99` by the author and five read-only explorers. The author personally re-read every load-bearing claim below and marked it ✔.

### Layout seam

- ✔ **Where the panel goes.** `App.tsx:135-139` renders the main row as `<main>…<MainSurface/></main>` followed by `<SidePanels/>`. `SidePanels` maps `sidePanelSurfaces` (`app/surfaces/registry.tsx:169-175`: git-bar, worktrees-bar, agent-status-panel, debug-surfaces) into flex siblings after `<main>`.
  - `App.tsx:36-58` forbids adding surfaces in `App.tsx`. The registry is the sanctioned seam.
  - A new entry renders in every window, because each window runs its own `App`. It sits inside `AgentTerminalOwnershipProvider`, which `MountedAgentTerminalOwner` requires, and outside `RetainedWorkspaceSurface`, so it stays visible during Settings, Reader, Spotlight and editor fullscreen.
- ✔ **Panel chrome.** `components/ui/side-panel.tsx` is the shared `SidePanel` shell: `aside`, `flex-shrink-0`, `border-l`, no z-index. Width is a Tailwind class there; a resizable panel passes an inline `style.width`.
- **Resizing.** There is no resize library. `features/shared/useResizableSplitter.tsx:75` (`{axis, enabled, onDrag}` → `{dragging, onMouseDown, cursorLock}`) and `features/shared/SplitHandle.tsx` are the in-house primitives, used by GlobalEditorShell, TiledDispatchLayout, ConversationsPicker and ResizableSidebar.
- **Narrowing `<main>` is already safe.** Nothing measures `<main>` itself. Leaves re-fit through their own ResizeObservers (`AgentTerminalLeaf.tsx:315`, `TerminalLeaf.tsx:535`, `PocketSlot.tsx:58`), and Git Bar and Agent Status already narrow it the same way.
- ✔ **Rendering an agent outside the lanes.** `renderWorkspaceLeaf(sessionId, focusedSessionId, workspace, tabId, agentViewMode, showStatusMode, showWorktreeBadges, onFocusRequest?, surfacePaneLabel?, pocketPlacement?)` (`workspace/tile-tree/TileTree.tsx:34-66`) is what Spotlight uses (`features/spotlight/ui/SpotlightView.tsx:81-95`). It chooses `TerminalLeaf` / `ExtensionViewLeaf` / `AgentTerminalLeaf` / `TileLeaf` by kind and view mode, and Hermes gets its chat surface inside `TileLeaf` (`TileLeaf.tsx:932-945`).
  - `tabId` is only used for `focusSessionInTab` when no `onFocusRequest` is given, and for `paneLabelForSession` when no `surfacePaneLabel` is given. Omitting `pocketPlacement` turns off the browser pocket.
  - The leaf reads `workspace.state.sessions[sessionId]` (`TileTree.tsx:103`) and `useSessionRuntime(workspace, id)`.
- ✔ **Keyboard.** `useInteractiveOwnership(focused)` (`TileLeaf/useInteractiveOwnership.ts:23-26`) returns `interactive = focused && visible`. That flag gates every document-level router: type-to-focus, paste-to-focus, the bare-Enter target (`composerEnterRegistry.ts`), dictation and the condition outlet. A lane's `focused` is `grid.focusedLane === laneIndex` (`TiledDispatchLayout.tsx:437,508`).
- **Commands.** A command is a `CommandDef` in a feature `commands/*.ts`, spread into `builtInCommandCatalog` (`features/command-palette/catalog.ts`, order pinned by `catalog.test.ts`). Its default key goes in `features/command-keybindings/defaults.ts`, and `npm run check:keybindings` (`scripts/check-command-keybindings.mts`) checks it. Templates: `toggle-git-bar` (`sessionCommands.ts:953-962`) and `show-agent-status` (`agentStatusCommands.ts:13-29`). Titles are noun phrases with no Toggle/Enable (`docs/command-style.md`).
- ✔ **Chords.** `Cmd+J` and `Cmd+Shift+J` are neither bound (`defaults.ts`) nor in `RESERVED_INTERACTIONS` (`command-keybindings/reservations.ts`).
  - Caveat from memory ("check:keybindings only knows THIS app's bindings"): macOS-reserved chords are not checked. ⌘J is not a macOS system shortcut. It is "Jump to Selection" in some text views, and Agent Code has no such menu item.

### Session ownership and persistence

- ✔ **The ownership rule.** A session is owned if and only if its `projectId` names an existing project: `collectOwnedSessionIds` (`workspace/sessionOwnership.ts:71-80`), with the long WHY at `:30-66`.
  - Autosave writes only owned rows. `useAutoSave.ts:72` calls `pruneSessionOwnership`, which drops the others with a `console.warn`.
  - Rehydrate drops unowned rows (`rehydrate.ts:151-200`).
- ✔ **Reload Agent, provider switch, rewind and MCP toggles all require ownership.** `replaceSession`'s `canCommit` (`hook/actions/session.ts:1295-1301`) checks `collectOwnedSessionIds(state).has(oldId)`.
  - Reload All (`session.ts:1597-1645`, `:1857`) **deletes** unowned rows from live state.
  - `sessionPlacement` (`pane.ts:254,409,1619`) returns null for them, so closing one does nothing.
- ✔ **Rehydrate's first publish replaces `sessions`** with `buildRemappedSessions()` and rebuilds runtimes from the restored set (`rehydrate.ts:456-512`). Anything added to state before restore finishes is wiped.
- **Spawn.** `spawn(cwd, opts)` (`session.ts:403-560`) calls `window.api.spawnSession`, and main claims the window lease at id-mint time (`main/ipc/session.ts:80-104`). It then writes an **unfiled** row with no `projectId`; the caller files it (`pool.ts:41-50 fileSessionInProject`).
- **Wake.** `ensureSessionLive(sessionId, caller)` (`session.ts:621+`) wakes from `state.sessions[sessionId]` alone through `session:recover`. That adopts a live backend after a renderer reload, or cold-starts under the same local id with `resumableProviderSessionId(meta)`.
- **Boot.** Only the focused lane's session is spawned at boot (`collectLiveProcessIds`, `sessionOwnership.ts:117-131`). Everything else wakes on first use.
- **Events for unknown ids.** `useIpcSubscriptions` creates runtimes for any id (`hook/helpers.ts:51-61`). Row-writing handlers (`provider-session-changed` `:984`, proxy-header id `:1232`, JSONL id `:1868`) do nothing while the row is missing. So a sidekick's provider identity is captured only while its row is in the window's `state.sessions`.
- ✔ **The workspace file.** `~/.config/agent-code/workspace.json` is `{version: 3, windows: PersistedWindow[]}` (`main/storage/workspaceFile.ts:37-55,70`).
  - Each window's `workspace` payload is opaque to main.
  - `WorkspaceFileStore` is the only writer, and `commit` serializes every write (`workspaceFileStore.ts:296-375`).
  - The composers `withWindowSlice` / `withoutWindow` (`workspaceFile.ts:268-295`) rebuild `{version, windows}`. **Any new top-level field must be carried through them by hand.**
  - `collectSessionIds` (`:305`) is the union of every slice's sessions.
- ✔ **Main-side readers of the persisted slices.** A sidekick is invisible to all of them unless they are fed from the sidekick index:
  - `store.sessionIds()` → `commitDurableOwnership` → `SessionManager.acknowledgePersistedSessionOwnership` (`main/ipc/workspace.ts:43-60`). This is the Codex same-rollout handoff commit. A sidekick would never commit its handoff and would leak the lease.
  - `conversationLedger.projectWindows(windows, names)` (`main/index.ts:1449`, `ledger.ts:112-160`) marks a row closed when no slice names it. A sidekick would be marked closed on every save.
  - `tldrIdentitiesInUse(windows)` (`main/tldr/identitiesInUse.ts:20-38`, wired at `main/index.ts:1250`) protects parked agents' TLDR/Goal from eviction. A sidekick would be evictable.
  - `projectWorkspace(windows)` (`main/agentActivity/workspaceProjection.ts:100`) feeds Agent Activity's titles and aliases (`AgentActivityRecorder.ts:123`) and the remote phone projection (`main/remote/workspaceProjection.ts:70`).
- ✔ **Window close hands every lease the closed window held to a survivor:** `bequeathedSessionIds = sessionsOwnedBy(closedWindowId)` → `transferSessions` (`main/index.ts:1537-1539`). A sidekick's lease would land in a window that never displays it.
- ✔ **One owner per session.** `SessionWindowRouter` (`main/window/sessionWindowRouter.ts`):
  - `claim()` refuses a second live window (`:153-156`);
  - `transfer()` is the only handoff and flushes held events to the new owner (`:175-191`);
  - session events go only to the owner (`sendToSessionWindow`);
  - `session:recover` from a non-owner fails (`ipc/session.ts:107-111`).
  - `session:reseed-conditions` (`ipc/session.ts:150-166`) re-emits cached conditions to the owner after a move.
- **Send to Window (#1481 / PR #1484) is not merged.** No such code exists on `d0c3df99`, so this plan does not depend on it. If it lands first, its move path must also skip sidekick rows (Out of scope, and a note in the PR).

### Hermes

- ✔ **Hermes is a remote kind.** `REMOTE_PROVIDER_KINDS = ['hermes']` (`shared/types/providerKind.ts:133`).
  - Spawn skips the folder check and the binary lookup, user MCP and skills (`sessionManager.ts:3034,3113-3135,3182-3190`). It throws `RemoteProviderNotConnectedError` without `remoteConnectionId`.
  - `cwd` is display metadata only.
- **Connections.** They live in `<STATE_DIR>/hermes/connections.json` (`main/hermes/connectionStore.ts`), and tokens are in per-connection safeStorage blobs. Renderer access goes through `useHermesConnections` (`features/hermes-chat/useHermesConnections.ts`).
  - `resolveRemoteConnectionId(kind, persisted?)` (`workspace/remoteConnection.ts:25-45`) resolves in this order: the persisted choice, then the first `ready`, then `unreachable`, then any connection, else none.
  - `spawn` awaits it for remote kinds only (`session.ts:427-429`).
- **Conversation identity.** Hermes conversations persist as `providerSessionId` with source `provider-follow`, via `provider-session-changed` (`hermesSession.ts:355-377`, `useIpcSubscriptions.ts:976-991`).
  - `/new` rotates the conversation inside the pane.
  - Restore resumes with `{mode:'resume', storedSessionId}`.
  - Nothing in the Hermes runtime or chat view depends on a tab. Only pane creation, `projectId` ownership and the `TileLeaf` host do.
- **The VPS** (`reference_integrations.md` memory): `https://hermes-agent-pjlj.srv1921318.hstgr.cloud`, v0.22.0. The client was recorded against v0.21.7, and v0.22.0 passed the live tier on 2026-10-14.

### State patterns to copy

- **Durable records.** The Hermes connection store (`connectionStore.ts`) is the pattern: coerce rows, drop malformed ones, move a corrupt file aside, block writes after a failed read, atomic 0600 temp+rename.
  - Its service (`main/hermes/service.ts`) is an EventEmitter with serialized mutations and `changed`.
  - Its IPC (`main/ipc/hermes.ts`) broadcasts with `broadcastToWindows`.
  - The preload side is `preload/api/hermes.ts`, and the renderer hook is `useHermesConnections`.
- **Kind choices.** `AGENT_PROVIDER_CHOICES`, `filterAgentProviderChoices` and `useEnabledAgentProviderKinds` (`workspace/providerChoices.ts:34-128`) reuse cleanly. The `NewAgentPlacementOverlay` component does not reuse (it is tied to tab and placement).
  - The picker template is `ProviderSwitchPickerModal.tsx`: a `Dialog` plus `useListNavigation` (`lib/useListNavigation.ts`, "the ONE implementation").
- **Home folder.** `defaultWorkspaceCwd()` (`main/ipc/workspace.ts:104-122`) returns `AGENT_CODE_CWD`, else `process.cwd()`, else home. It is **not** "home". Sidekicks use `os.homedir()` exactly (Design §4).

### Consumer audit

Every reader of `state.sessions`, and of the slices in main, was classified for a row with `sidekickId` and no `projectId`. The full table is in Design §9. Summary:

- **Already excluded:** about 20 surfaces, all through `resolveTabSessions` / `buildDispatchGroups` / `placedSessionIds`. That covers the Dispatch index, pins rendering, Close Old/Idle/Completed Agents, Bulk Provider Switch, Agent Activity rows, Agent Management MCP and child spawns.
- **Need a guard:** autosave (sessions, drafts, pins), `pinSession` / `setPinnedSessionIds` and the pinned-ids effect, lane writes (`selectTiledLaneSession`, `applyDispatchSpawnFocus`, Control `lane-select`), the Control SDK / extension `sessions.observe` listings, and main's window-close bequest.
- **Must keep working:** the ownership clause, which fixes replace/Reload All/close; the membership carry on replacement (`pool.ts:59-66 inheritedMembership`); the rehydrate first-publish merge; Undo Close (skip for sidekicks); the close path; agent names (the index must store `agentNameId`); and the four main projections above.

## Decisions

1. **Name: "Sidekick".** UNCONFIRMED. It is always beside you, and the name is free in the codebase. Rejected: *Pocket* (collides with the browser pocket, #1149), *Companion* (the remote mobile companion), *Dock* (the macOS Dock). Alternatives offered: *Home Agent*, *Rail*.
2. **Global across windows, live in one window at a time.** UNCONFIRMED. One index serves every window. A sidekick is live in exactly one window; **Open here** moves it with the router's `transfer()`. Mirroring it live in every window would need a router rewrite and is rejected for v1.
3. **One sidekick in the panel at a time,** switched with the picker. UNCONFIRMED. Alternative: a tab strip inside the panel.
4. **Folder: always `os.homedir()`.** UNCONFIRMED. Alternative: choose a folder per sidekick at creation.
5. **Kinds: every enabled kind, Hermes included.** UNCONFIRMED. Hermes uses the first signed-in connection (`resolveRemoteConnectionId`). **New Sidekick** puts Hermes first when a connection is `ready`, otherwise Claude.
6. **Isolation.** UNCONFIRMED; it is the author's reading of "a 100% tight agent compared to being a part of the big structure". Sidekicks stay out of lanes, Dispatch, the bulk closes, adoption merge, Agent Management MCP, the extension and Control session listings, and Send to Window. They keep agent names, TLDR/Goal, wake/recovery, Reload Agent and provider switch, and the Conversations ledger.
7. **Panel geometry.** UNCONFIRMED.
   - Resizable from its left edge: 420 px default, clamped to 300 px or more and 60% of the window width or less.
   - Open state, width and the shown sidekick are remembered per window.
   - ⌘J opens and focuses the panel, focuses it if it is open but unfocused, and closes it if it already has the keyboard.
   - ⌘⇧J opens the picker.
8. **Close vs remove.** UNCONFIRMED.
   - Closing the panel only hides it, and the process keeps running like a parked lane agent.
   - **Remove Sidekick** (in the picker, with a confirmation) kills the process and drops it from the index. Its conversation stays in the native store and the Conversations picker.
9. **Mode.** Answered 2026-10-14: write the plan first. The build waits for the owner's explicit go, then runs to an open PR.

## Design

### 1. Data model: who owns what

```
                   main (one per app)                         renderer (one per window)
 ┌──────────────────────────────────────────┐        ┌──────────────────────────────────────┐
 │ workspace.json                            │        │ WorkspaceState                        │
 │  { version: 3,                            │        │  sessions: { …lane rows (projectId),  │
 │    windows: [ …per-window slices… ],      │        │              …the ONE sidekick row    │
 │    sidekicks?: {version:1, records:[…]} } │◀──────▶│              this window holds        │
 │      ▲ written ONLY by SidekickService    │  IPC   │              (sidekickId, no project) }│
 │      │ via WorkspaceFileStore.commit       │        │  sidekickPanel: { open, width,        │
 │ SessionWindowRouter: sessionId → windowId │        │                   sidekickId }  ◀─ per-window pointer,
 └──────────────────────────────────────────┘        │                                       persisted in the slice
                                                      └──────────────────────────────────────┘
```

**Invariants:**

- **I1. The record is the durable truth.** A sidekick's durable identity is its `SidekickRecord` in `workspace.json.sidekicks`. A window slice never contains a sidekick row (I1 is enforced at autosave).
- **I2. One window holds a sidekick at a time.** At most one window's `state.sessions` holds a given sidekick's row, and it is the window that holds the router lease for `record.sessionId`. Every other window shows the record from the index view only.
- **I3. Only the lease holder writes.** Only the lease holder may write the record's `meta`/`sessionId`; `SidekickService` checks the lease on every write. This is the single-writer rule that keeps two windows from drifting, the same failure `agentNameId`'s comment describes (`types.ts:166-180`).
- **I4. The index owns the row.** A row with `sidekickId` is owned, and is never pruned while its window holds it. It disappears from a window only through **release** (moved away) or **remove**.
- **I5. Lanes never point at a sidekick.** No lane, pin, Spotlight or Reader target names a sidekick session.

### 2. Shared types: `src/shared/sidekicks/types.ts` (new)

- `SidekickId = string`, a UUID minted by the renderer at creation (§5.1) and validated by main (`/^[0-9a-f-]{36}$/`).
- `SidekickRecord = { id: SidekickId; sessionId: string; createdAt: number; lastActiveAt: number; meta: unknown; draft?: string }`.
  - `meta` is the renderer's `SessionMeta`, opaque to main, the same stance as window slices (`workspaceFile.ts:12-19`).
  - Main reads only narrow fields, defensively: `kind`, `providerRuntime`, `cwd`, `title`, `agentNameId`, `tldrIdentity`, `remoteConnectionId`.
  - `draft` is the composer draft. Sidekick drafts are excluded from the slice's `drafts`, so they need a durable home.
- `PersistedSidekicks = { version: 1; records: SidekickRecord[] }`. Array order is creation order; new records are appended. The picker sorts by `lastActiveAt`, so order carries no meaning beyond stability.
- `SidekickSummary = { id; sessionId; kind: string; providerRuntime?: string; title: string | null; agentNameId: string | null; remoteConnectionId: string | null; createdAt; lastActiveAt; liveWindowId: string | null }`.
- `SidekickIndexView = { revision: number; homeDir: string; sidekicks: SidekickSummary[] }`.
- `SidekickAttachResult = { ok: true; record: SidekickRecord } | { ok: false; reason: 'not-found' | 'window-gone' | 'owned-elsewhere' }`.
- Channel names live in this file as constants:
  - invoke: `sidekick:list`, `sidekick:register`, `sidekick:save`, `sidekick:attach`, `sidekick:take`, `sidekick:remove`;
  - events: `sidekick:changed` (broadcast) and `sidekick:released` (to the window losing a sidekick).

### 3. Main: the `sidekicks` section of `workspace.json`

`src/main/storage/workspaceFile.ts`:

- `WorkspaceFile` gains `sidekicks?: PersistedSidekicks`.
- `parseWorkspaceFile` coerces it with `coercePersistedSidekicks(raw)`. A missing section means empty. A malformed record (bad id, missing `sessionId`) is **dropped**, in the Hermes store's style. A section that is not an object is dropped in full and logged, never thrown.
- **Every composer carries it:**
  - `withWindowSlice` and `withoutWindow` copy `file.sidekicks` through untouched;
  - the geometry update at `workspaceFileStore.ts:251-262` does the same;
  - the new `withSidekicks(file, sidekicks)` replaces it.

  **Why this matters:** today the composers rebuild `{version, windows}`, so without the carry the first window save would silently erase the index.
- `collectSessionIds(file)` adds `record.sessionId` for every sidekick record. That fixes the Codex handoff commit and lease leak through the one existing funnel.
- `serializeWorkspaceFile` writes `sidekicks` only when there is at least one record, so files with no sidekicks are byte-for-byte unchanged.
- **Ruling: no `WORKSPACE_FILE_VERSION` bump.** The section is optional and ignored by older v3 readers. **Cost if wrong:** an older build that saves drops the section (its composers don't carry it), losing the index. The sidekick conversations themselves survive in the native stores and in Conversations. That is a recoverable inconvenience on downgrade, not a reason to make every older build read-only (which is what a bump to 4 would do; see `workspaceFile.ts:57-71`).

`src/main/storage/workspaceFileStore.ts`:

- `sidekicks(): PersistedSidekicks` reads the section.
- `commitSidekicks(compose: (current: PersistedSidekicks) => PersistedSidekicks): Promise<void>` runs through the **same** `commit` queue, so a sidekick write and a window save can never interleave.
- `observe(listener)` changes to `(snapshot: { windows: readonly PersistedWindow[]; sidekicks: PersistedSidekicks }) => void`, and `windows()` stays for restore. **Ruling:** projections get sidekicks explicitly, never as a fake window, because startup restore iterates `windows()` to create real windows (`main/index.ts:1626`).

### 4. Main: `SidekickService` (`src/main/sidekicks/SidekickService.ts`, new)

It is constructed in `main/index.ts` next to the Hermes service, with access to `workspaceFileStore`, the router helpers (`captureSessionWindowLease`, `claimSessionForWindow`, `transferSessions`/`transfer`, `releaseSession`, `isSessionWindowLeaseCurrent`), `windowRegistry`, `SessionManager` and `os.homedir()`. It is an EventEmitter with `changed`.

Every mutation is serialized through `commitSidekicks`, and every method takes the requesting `windowId` from `evt.sender`:

- **`view(): SidekickIndexView`.** Summaries come from `records` plus `liveWindowId = captureSessionWindowLease(record.sessionId)?.windowId ?? null`. `homeDir` is `os.homedir()`.
- **`register(windowId, {id, sessionId, meta})`.** Precondition: the lease for `sessionId` is held by `windowId` and is current. It appends a record. It refuses a duplicate `id` and a `sessionId` that is already some record's.
- **`save(windowId, {id, sessionId, meta, draft?})`.** This is the single writer path (I3).
  - Precondition: the lease for the record's **new** `sessionId` is held by `windowId`.
  - `sessionId` may differ from the stored one. That is a replacement (Reload Agent, provider switch, rewind), and main accepts it only when the requester also holds, or held, the old one: either the old lease is `windowId`'s, or the old session has no lease (it was killed by the replacement).
  - It updates `lastActiveAt` on every save.
- **`attach(windowId, id): SidekickAttachResult`.** For a sidekick nobody holds:
  - if `liveWindowId` is null, it claims the lease for `record.sessionId` for `windowId` (`claimSessionForWindow`) and returns the record;
  - if another live window holds it, it returns `owned-elsewhere`.
- **`take(windowId, id): SidekickAttachResult`.** This is the **move**, the "Open here" path:
  1. Look up the holder `A`. If `A` is gone or null, behave like `attach`.
  2. `transfer(record.sessionId, windowId)`. The router moves the lease and flushes held events to the new owner.
  3. `sendToWindow(A, 'sidekick:released', {sidekickId: id, sessionId})`.
  4. Return the record **as last saved**. The new window's first `save` refreshes it.
  5. Emit `changed`.

  **Ordering argument:** the transfer happens before the release notice. A's later writes (`save`) then fail the lease check (I3), and its late `kill-owned` / `deliver-prompt` calls fail the existing per-call lease checks (`ipc/session.ts:181-197`). So A can never act on a session it no longer owns, even if its renderer is slow to process `released`.
- **`remove(windowId, id)`.** It kills the process with main's own authority (`manager.killOwned` with caller `sidekick-remove`), the same authority shutdown uses. It releases the lease, removes the record, and sends `sidekick:released` to the holder if that is not the requester. This works from any window: the user removes from the picker wherever they are.
- **`excludeFromBequest(sessionIds): string[]`.** Returns `sessionIds` minus the sessions of sidekick records. **Window close** (`main/index.ts:1537`) changes to `transferSessions(exclude(bequeathed), survivor)`, and the sidekick sessions are **released** instead.
  - **Ruling: release, not transfer.** The survivor never displays the sidekick, so a transfer would route its events into a window that only builds orphan runtimes for them. Released, the process keeps running, its events wait in the router's bounded hold, and the next window to show it claims through `attach` + `session:recover`, which adopts the live backend and records a routing gap that reseeds.
  - **Cost if wrong:** events beyond the hold bound are dropped, and the gap/reseed path repairs the view. That is the existing contract for any unowned session.

IPC (`src/main/ipc/sidekicks.ts`, new):

- Thin handlers that validate input shapes and call the service.
- `service.on('changed')` → `broadcastToWindows('sidekick:changed', view())`.
- Registered in `main/index.ts` beside `registerHermesIpc`.

Preload (`src/preload/api/sidekicks.ts`, new) exposes `listSidekicks()`, `registerSidekick()`, `saveSidekick()`, `attachSidekick()`, `takeSidekick()`, `removeSidekick()`, `onSidekicksChanged(cb)` and `onSidekickReleased(cb)` (with `subscribeShared`). It is added to the flat api in `preload/api/index.ts`.

**Projections take `(windows, sidekicks)`:**

- `projectWorkspace(windows, sidekicks)` adds a placement per record: `tabId: null`, `tabTitle: 'Sidekick'`, plus `kind`, `cwd`, `title`, `agentNameId`, `tldrIdentity`, `pinned: false`, `orchestration: false`. This feeds Agent Activity's titles and the remote projection.
- `conversationLedger.projectWindows(windows, names, sidekicks)` counts a record's session as seen, so it is never marked closed while in the index. It is marked closed on **remove**.
- `tldrIdentitiesInUse(windows, sidekicks)` adds `tldrIdentity` and `sessionId` per record.
- **Remote phone.** Sidekicks are listed through the shared projection, with title and name, under "Sidekick". The cost is one line; the alternative of hiding them from the phone is listed as a follow-up option, not done.

### 5. Renderer model

**`SessionMeta.sidekickId?: SidekickId`** (`workspace/types.ts`) gets a thick WHY comment: it is the second ownership fact, its owner is main's index, and it never coexists with `projectId`.

**`sessionOwnership.ts`:**

- `collectOwnedSessionIds`: owned if `projectId ∈ projects` **or** `meta.sidekickId !== undefined` (I4). The WHY comment notes the audit's three breakages: `canCommit`, Reload All deletion, close no-op.
- New `collectPersistableSessionIds(input)` returns the owned ids minus sidekick rows. `pruneSessionOwnership` gains `persistedSessions` (persistable rows only). Lanes are scrubbed against **persistable** ids (I5) through `keepTiledLaneSessions`.
- `collectLiveProcessIds` is unchanged: sidekicks never sit in lanes, so the boot spawn set never includes one. The panel wakes its own sidekick (§6).

**`useAutoSave.ts`:**

- Writes `pruned.persistedSessions`.
- Drafts and pins are computed against `persistedSessions`.
- Sidekick rows are **not** reported as dropped. They are persisted elsewhere, so they don't trigger the "dropping unowned sessions" warning.
- New persisted pointer: `sidekickPanel` (below).

**`pool.ts inheritedMembership`** carries `sidekickId` alongside `projectId` / `joinedAt`, so a replacement (Reload Agent, provider switch) keeps the row a sidekick. `useSidekickPersistence` then sees a new `sessionId` for the same `sidekickId` and saves it (§6).

**`rehydrate.ts` first publish** merges `prev.sessions` rows with `sidekickId`, and their runtimes, into the restored set. It is a fail-first fix: the audit's wipe of anything added before restore finishes.

**Guards** (refuse, with a one-line WHY each, citing I5):

- `pinSession`, `setPinnedSessionIds` and the pinned-ids validity effect (`effects.ts:170-195`) treat sidekick rows as invalid pins.
- `selectTiledLaneSession`, `applyDispatchSpawnFocus` and Control `lane-select` (`control/layout.ts:103`) refuse sidekick rows.
- `setSpotlightSession` and `focusSessionInTab` don't need a guard: `resolveFocusSurfaceTarget` already refuses rows with no project (`focusSurfaceTarget.ts:31`).
- Control `observeWorkspace` (`workspace/control.ts:45-87`) and the extension `sessions.observe` / count (`apps/api/createAppHostApi.ts:131,144`, `apps/api/sessionStatus.ts:65`) skip sidekick rows. **Ruling:** that keeps the extension and Control contracts unchanged in v1. Exposing sidekicks there is a follow-up issue.
- `agentManagementMcp.ts:382` name lookup: candidates are filtered to project rows, so a sidekick can't cause a false `name_ambiguous`.

**Closing and Undo:**

- **Unchanged:** `closeSession` / `sessionPlacement` still refuse sidekick rows. A sidekick is removed only through `removeSidekick` (§6), and hiding the panel is not a close.
- Undo Close never captures a sidekick: `undoClose` entries skip sidekick rows.

**Per-window panel pointer:**

- `WorkspaceState.sidekickPanel: { open: boolean; width: number; sidekickId: SidekickId | null }`, persisted in the slice as `PersistedWorkspace.sidekickPanel?`.
- It is a **pointer**, scrubbed on load and on every `sidekick:changed` against the index view: an unknown `sidekickId` becomes `null`.
- `width` is clamped on read to 300 px or more and at most `max(300, 0.6 × innerWidth)`.

### 6. Renderer: the sidekick feature (`src/renderer/src/features/sidekick/`, new)

**`state/sidekickIndexStore.ts`.** A non-persisted zustand store holding `SidekickIndexView` (`revision`-gated, so a stale broadcast can't overwrite a newer one).

**`state/useSidekickIndexSync.ts`.** Loads `listSidekicks()` on mount and subscribes to `onSidekicksChanged`. It is mounted by the panel surface, which is always rendered so it can sync even while closed (§7), and needs no `App.tsx` edit.

**`actions/sidekickActions.ts`** is exposed as `useSidekickActions(workspace)`. Every action carries a WHY on its ordering.

- **`createSidekick({kind, providerRuntime})`:**
  1. `sidekickId = crypto.randomUUID()`.
  2. `sessionId = await workspace.spawn(homeDir, {kind, providerRuntime})`. For Hermes, `spawn` resolves `remoteConnectionId` itself.
  3. **Synchronously in the same tick:** `fileSessionAsSidekick(sessionId, sidekickId)`. This sets `sidekickId` on the row, mirroring `fileSessionInProject`, so autosave never sees the row unfiled.
  4. `await window.api.registerSidekick({id, sessionId, meta})`.
  5. Point the panel at it and give it the keyboard.

  On a register failure, kill the session (`killSession(sessionId, 'sidekick-register-failed')`), drop the row, and show a toast.
- **`showSidekick(sidekickId)`.** The panel calls this when its pointer changes or it mounts with one:
  1. Look up the summary. If this window already holds the row, it's a no-op.
  2. If `liveWindowId` is another window, set the panel state to `elsewhere`; this does not take.
  3. Otherwise `attachSidekick(id)`. On `ok`, insert the row `record.meta + {sidekickId}`, seed the runtime from `emptyRuntime()`, restore `record.draft` into `runtime.draftInput`, then `ensureSessionLive(record.sessionId, 'sidekick-attach')` and `session:reseed-conditions`.
- **`openHere(sidekickId)`** runs `takeSidekick(id)`, then the same insert-and-wake as `showSidekick`. `session:recover` from the new owner adopts the live backend (`sessionManager.ts:2023-2056`). Kind, runtime and cwd match because the record's meta is the last saved one.
- **`onSidekickReleased({sidekickId, sessionId})`.** Remove the row and runtime from this window's state **without killing**: a new `releaseSidekickRow` path that bypasses `closeSession`. Keep the panel pointer, so the panel now shows `elsewhere`.
- **`removeSidekick(sidekickId)`:**
  1. Confirm in a dialog.
  2. `removeSidekick(id)` (main kills and drops it).
  3. If this window held it, `releaseSidekickRow`.
  4. Point the panel at the next most recent sidekick, or `null`.
- **`useSidekickPersistence()`.** An effect over `state.sessions` rows with `sidekickId`, debounced at 400 ms like autosave. When the row's meta object, its `sessionId` or the runtime `draftInput` changes, call `saveSidekick({id, sessionId, meta, draft})`. It also flushes on `beforeunload` (the autosave precedent). That is how provider identity, `agentNameId`, title, `remoteConnectionId` after Hermes `/new`, and MCP overrides become durable (I3).

**Keyboard region.** `uiShell` gains `keyboardRegion: 'workspace' | 'sidekick'`, window-local and not persisted. A `KeyboardRegionContext`, defaulting to `'workspace'`, is provided as `'sidekick'` around the panel's leaf.

- `useInteractiveOwnership(focused)` becomes `interactive = focused && visible && region === storeRegion`.
- Why this file: it is the single choke point for every document-level router, and the lane layout files stay untouched.
- The panel surface installs one capture-phase `pointerdown` + `focusin` listener on `document`. A target inside the panel sets `'sidekick'`, and anything else sets `'workspace'`. ⌘J sets it explicitly.
- **Refocus:** TileLeaf moves the caret on a `focused` flip (`TileLeaf.tsx:317-327`). The build must check whether that effect keys on `focused` or `interactive`. If it keys on `focused`, the same effect re-keys on `interactive` so returning to a region restores its caret. This is recorded as a task check, not assumed.

### 7. Renderer: the panel UI

**`ui/SidekickPanelSurface.tsx`** is registered **last** in `sidePanelSurfaces`, so it is the far-right column; Git Bar and Agent Status sit between the lanes and it.

- It always mounts: `useSidekickIndexSync`, `useSidekickPersistence` and the released listener.
- It renders `SidekickPanel` only while `sidekickPanel.open`.

**`ui/SidekickPanel.tsx`** is a `SidePanel` with `label="Sidekick"` and `style={{width}}`:

- **Left edge:** `SplitHandle` + `useResizableSplitter({axis:'x', onDrag})`. A drag updates `sidekickPanel.width`, clamped (Decision 7). Keyboard nudging comes from `SplitHandle`.
- **Header:** sidekick name (agent name or title), kind badge, Hermes connection name (`useHermesConnections`), a "Switch" button that opens the picker, and a close button that hides the panel (Decision 8).
- **Body states:**
  - `empty` (no sidekicks): the New Sidekick kind list inline, using the same rows as the picker.
  - `elsewhere`: "Live in another window", with **Open here**.
  - `attaching`: a spinner.
  - `failed`: the error, with Retry.
  - `live`: `renderWorkspaceLeaf(sessionId, focusedSessionId, workspace, SIDEKICK_SURFACE_TAB_ID, agentViewMode, showStatusMode, showWorktreeBadges, onFocusRequest, 'S')`, where:
    - `focusedSessionId = keyboardRegion === 'sidekick' ? sessionId : null`;
    - `onFocusRequest` sets the region to `'sidekick'`;
    - `SIDEKICK_SURFACE_TAB_ID = 'sidekick'`. It is documented as never resolved, because `onFocusRequest` and `surfacePaneLabel` are both always passed. The leaf is identical to Spotlight's, with no pocket.
- **Narrow width:** the leaf is the ordinary one. The Hermes chat surface and the feed already wrap; terminal view mode is allowed but fits 300 px poorly, which is a known limitation.

**`ui/SidekickPicker.tsx`** is a `Dialog` + `useListNavigation`, opened from `uiShell.sidekickPickerOpen` (window-local).

- **Rows:**
  1. Sidekicks sorted by `lastActiveAt`, newest first. Each shows name, kind, connection, "here" / "in another window" / "asleep", and a relative last-active time.
  2. A divider.
  3. **New Sidekick** rows: `filterAgentProviderChoices(AGENT_PROVIDER_CHOICES, enabledKinds)`. Hermes moves to the top when a connection is `ready`, otherwise Claude stays first (Decision 5). Hermes is **disabled**, with "Sign in under Settings → Hermes", when there is no connection.
- **Keys:**
  - Enter switches (`showSidekick`, or `openHere` if it's elsewhere) or creates.
  - ⌘⌫ removes, with a confirmation.
  - Esc closes.
- `KbdLegend` shows these keys.

**Commands** (`features/sidekick/commands/sidekickCommands.ts`; category `Sidekick`, surface `app`):

| id | title | key | behaviour |
|---|---|---|---|
| `sidekick-panel` | Sidekick | ⌘J | `getState`: toggle of `sidekickPanel.open`. Run: closed → open + region `'sidekick'`; open without keyboard → region `'sidekick'`; open with keyboard → close + region `'workspace'`. |
| `sidekick-picker` | Sidekick Picker… | ⌘⇧J | Opens the panel if needed, then the picker. |
| `new-sidekick` | New Sidekick… | — | The picker, scrolled to the New Sidekick rows. |
| `remove-sidekick` | Remove Sidekick… | — | Confirm, then remove the shown sidekick. |

All four go into `builtInCommandCatalog` (update the `catalog.test.ts` counts) and into `defaults.ts`, with `context: 'global'`. Control routes (`uiShell/control.ts`) gain `sidekick-panel` for `ui.surfaceSet`, following the Git Bar precedent.

### 8. Hermes as a first-class sidekick

- **Nothing in Hermes changes.** `HermesSession`, the chat surface, conditions, the composer and `/new` all work through `TileLeaf` exactly as in a lane.
- `createSidekick({kind: 'hermes'})` → `spawn` → `resolveRemoteConnectionId('hermes')`, which picks the first `ready` connection. The record's meta stores `remoteConnectionId`, so a restore reopens the same server (`types.ts:340-345`).
- **Picker readiness:** `useHermesConnections()` statuses drive the Hermes row: `ready` puts it first, `unreachable` keeps it enabled with a warning dot, and none disables it.
- **Panel header** shows the connection name for Hermes, the same source `TileLeaf` uses.
- **`/new` in a sidekick** rotates the Hermes conversation, and `provider-session-changed` updates the row. `useSidekickPersistence` saves it, and the sidekick keeps its identity across conversations (Decision 5 of the Hermes plan: the pane is the chat).
- **Follow-ups, not built:** a per-sidekick connection picker (#1485) and a Hermes conversation picker inside the sidekick (#1486). The sidekick record already stores `remoteConnectionId`, so #1485 lands without a migration.

### 9. Consumer audit (complete; from the read-only audit, re-checked where marked ✔)

**Already excluded, no change** (a row with no `projectId` falls out through `resolveTabSessions` / project grouping):
- `queries.ts:60`
- `dispatchSelectors.ts:38-180, 272-280`
- `dispatchTarget.ts:35`
- `idleOrchestrationAgents.ts:111,147,186`
- `completedGoalAgents.ts:96,204,238`
- `CloseOldAgentsModal.tsx:144,174`
- `BulkProviderSwitchModal.tsx:303`
- `PinAgentsSurface.tsx:72,84`
- `activityRow.ts:281`, `agentActivityClose.ts:67,97`
- `agentManagementMcp.ts:92,287,306,414`
- `orchestrationMcp.ts:293`
- `paneLabels.ts:54,151`
- `focusSurfaceTarget.ts:31`
- `pane.ts:751,1251,1340`, `PathPickerSurface.tsx:53`, `tabCommands.ts:32`
- `adoptWorkspace.ts:80,107`, `useWorkspaceAdoption.ts:213-267` (incoming slices never contain sidekicks)
- `workspaceShape.ts:242-272`, `legacyWorkspaceV2.ts:208-273`
- `recoveryProjection.ts:56`
- `effects.ts:112-117`

**Guarded by this plan** (§5): `useAutoSave.ts:72,106,115,156`; `sessionOwnership.ts:166-193`; `dispatch.ts:488-526` (pins); `effects.ts:170-195`; `dispatch.ts:170`; `pane.ts:689`; `control/layout.ts:103`; `workspace/control.ts:45-87`; `apps/api/createAppHostApi.ts:131,144`; `apps/api/sessionStatus.ts:65`; `agentManagementMcp.ts:382`; ✔ `main/index.ts:1537` (bequest).

**Must keep working, fixed by this plan:**
- ✔ `collectOwnedSessionIds`
- ✔ `session.ts:1295-1301` `canCommit`
- `session.ts:1597-1645,1857` (Reload All)
- `pool.ts:59-66` (membership carry)
- ✔ `rehydrate.ts:456-512` (first publish)
- `undoClose.ts:108,147,265` (skip)
- the agent-names reconciler (`reconcile.ts:61,91`): works on any row, and `agentNameId` is persisted through `useSidekickPersistence`
- ✔ the four main projections (§4)

**Single-row readers, no change:** TileLeaf, the leaves, every `commandTarget(ctx)` command, the modals, debug, browser pocket UI and Control single-id calls. They only see a sidekick when the panel or an explicit target hands it to them, and that is correct.

The palette **does** reach a sidekick in one way: `commandTarget(ctx)` honours an explicit `ctx.target` (`command-palette/commandTarget.ts:21`). The panel header's context menu passes the sidekick as the target, so commands like Reload Agent, Switch Provider, Rewind, MCP Servers and Agent Title work on it. Commands that mean "put it in a lane / project" (Spotlight, Pin, Close…, Merge into Project) are hidden for sidekick targets through a `targetIsSidekick` guard on their `isAvailable`.

**Ruling:** that guard covers the handful of commands that file, place or close a session. The full list is pinned during the build by a test that walks the catalog with a sidekick target and asserts no command mutates `projectId`, lanes or pins.

## Files

New:
- `src/shared/sidekicks/types.ts`
- `src/main/sidekicks/SidekickService.ts` (+ `.test.ts`)
- `src/main/ipc/sidekicks.ts`
- `src/preload/api/sidekicks.ts`
- `src/renderer/src/features/sidekick/`:
  - `state/sidekickIndexStore.ts`, `state/useSidekickIndexSync.ts`
  - `actions/sidekickActions.ts`, `actions/useSidekickPersistence.ts`
  - `ui/SidekickPanelSurface.tsx`, `ui/SidekickPanel.tsx`, `ui/SidekickPicker.tsx`
  - `ui/KeyboardRegionContext.tsx`
  - `commands/sidekickCommands.ts`
  - tests

Changed:
- **Main:**
  - `main/storage/workspaceFile.ts`, `workspaceFileStore.ts`
  - `main/index.ts` (service, IPC, bequest, projections)
  - `main/agentActivity/workspaceProjection.ts`, `main/conversations/ledger/ledger.ts`, `main/tldr/identitiesInUse.ts`, `main/remote/workspaceProjection.ts`
- **Preload:** `preload/api/index.ts`
- **Renderer workspace model:**
  - `renderer/src/workspace/types.ts`, `sessionOwnership.ts`, `pool.ts`, `persistence.ts`
  - `hook/persistence/useAutoSave.ts`, `hook/persistence/rehydrate.ts`
  - `hook/actions/dispatch.ts`, `hook/actions/pane.ts` (`fileSessionAsSidekick`, `releaseSidekickRow`), `hook/actions/undoClose.ts`
  - `hook/invalidation/effects.ts`, `workspace/control.ts`, `control/layout.ts`
- **Renderer elsewhere:**
  - `apps/api/createAppHostApi.ts`, `apps/api/sessionStatus.ts`
  - `agentManagementMcp.ts`
  - `TileLeaf/useInteractiveOwnership.ts` (and the TileLeaf refocus effect if needed)
  - `app-state/uiShell/slice.ts` (+ `control.ts`), `app/surfaces/registry.tsx`
  - `features/command-palette/catalog.ts` (+ test), `features/command-keybindings/defaults.ts`
  - the `isAvailable` of the lane- and project-placing commands
- **Docs:** `ARCHITECTURE.md` (§5 building blocks, §8 ownership; Appendix B requires it because ownership changes), and `docs/command-style.md` only if a rule changes (not expected).

**Not changed (the layout promise):** `TiledDispatchLayout.tsx`, `GridRowView`, `gridShape.ts`, `MainSurface.tsx`, `App.tsx`, `GlobalEditorShell.tsx`.

## Tests

Real data first, following the user's integration-test feedback.

**Fixture provenance:**
- **W1** is extracted from the owner's real `~/.config/agent-code/workspace.json`: one real v3 window slice. Paths, titles and provider ids are redacted to the same length and documented in a fixture README, like `test/fixtures/slash-picker/README.md`.
- **W1+S** is W1 plus a mechanical mutation: a `sidekicks` section built from one real slice row (a Claude row and a Hermes row from a `hermes` pane, if one exists on disk; otherwise a Hermes row derived from the Hermes plan's recorded fixtures, labelled as derived).

Each test names the failure it shows before the fix:

1. **`workspaceFile.sidekicks.test.ts`.** A `saveSlice` / `withoutWindow` / geometry update on W1+S keeps `sidekicks` byte-identical. Before the fix, the first save erases the section. A malformed record is dropped; a non-object section is dropped and logged; a file with no section serializes unchanged. `collectSessionIds` includes sidekick sessions.
2. **`SidekickService.test.ts`** uses the real `WorkspaceFileStore` on a temp dir and a real `SessionWindowRouter`; only `windowRegistry` is a stand-in.
   - `register` without the lease is refused.
   - `save` from a non-holder is refused (I3), and a replacement `sessionId` is accepted only from the holder.
   - `take` transfers the lease, then sends `released` to A, and A's later `save` is refused.
   - `remove` kills, releases, drops the record and notifies the holder.
   - `excludeFromBequest` drops sidekick sessions.
3. **Window-close bequest test** (extracts the composition at `main/index.ts:1537` into a tested function). Before the fix, the sidekick lease goes to the survivor.
4. **Projection tests:**
   - The ledger does not mark a sidekick closed while the record exists (before: closed on every save);
   - TLDR identities include sidekick identities;
   - Agent Activity places sidekicks as "Sidekick".
5. **`sessionOwnership.sidekick.test.ts`:**
   - A sidekick row is owned but not persistable.
   - A lane naming one is scrubbed.
   - Autosave output for W1 plus an in-memory sidekick row contains no sidekick row, draft or pin. Before the fix, the row is dropped with the "dropping unowned" warning and is not owned.
6. **`replaceSession` on a sidekick row commits and keeps `sidekickId`.** Before: `canCommit` returns false and nothing happens. Reload All keeps the row (before: deleted).
7. **Rehydrate merge** (renderer test on the existing rehydrate harness): a sidekick row inserted before the first publish survives it. Before: wiped.
8. **Guards:** pin, lane select and Control `lane-select` refuse sidekick rows. The catalog walk with a sidekick target asserts no command mutates `projectId`, lanes or pins.
9. **Keyboard region** (renderer, two mounted `TileLeaf`s, a lane and the panel): Enter, paste and type-to-focus reach exactly one composer per region. Before: both focused leaves claim Enter.
10. **Panel and picker** (renderer):
    - the empty state;
    - creating Claude calls `spawn(homeDir)`, files `sidekickId` in the same commit, then registers;
    - Hermes is disabled with no connection and first when one is `ready`;
    - the `elsewhere` → Open here → live flow (the `window.api` boundary mocked as main's real contract shapes);
    - `released` drops the row without a kill.
11. **`useSidekickPersistence`:** a provider-session change (Hermes `/new`) saves the new `providerSessionId`; a replacement saves the new `sessionId`.

**Mutation check:** after the build, revert each guard and each ownership or merge fix one at a time and record which tests go red. Per memory, a surviving mutant is a statement about the test suite, not a reason to delete the guard.

## Verification

- `npx tsc -b` on both projects (per memory, never `--noEmit` on the node project), with `rm -rf .tsc-out` first.
- Scoped `vitest` while iterating; one full `npm run check` at the end, which includes `check:keybindings` and `test:contract`.
- **Failures:** the known local env failures (memory: imageAttachment, store timeouts) are classified against `origin/main`, not dismissed.
- CI `quality-gate` is the real gate.

**Verification boundary.** The app is never launched (owner rule), so these are **unverified** and listed as manual QA in the PR:
- the panel's look at 300–800 px;
- the ⌘J feel;
- a real two-window **Open here** move with a running Claude turn;
- Hermes against the real VPS (`https://hermes-agent-pjlj…`, v0.22.0) in a 420 px panel;
- a quit/relaunch restore;
- dictation into the panel.

## Out of scope

- Mirroring one sidekick live in several windows (router fan-out).
- Several sidekicks visible at once, or a tab strip.
- A per-sidekick folder.
- Sidekicks as orchestration parents or Agent Management callers (they get `caller_not_found` today; a scope rule is a follow-up).
- Sidekick terminals (shell kind). The index would need to protect `tmuxName` (`tmuxRecovery.ts:86`). Kind choices exclude Terminal.
- The Hermes connection picker (#1485) and the Hermes conversation picker (#1486).
- Send to Window integration (PR #1484 unmerged; when it lands, its move must skip `sidekickId` rows).
- Exposing sidekicks to the extension SDK or the Control catalog.

## Tasks

Each task names what it hands to the next. Every commit gets thick WHY comments; tests follow the Tests section, written to fail first where marked.

1. **Shared types and the file section.** `src/shared/sidekicks/types.ts`, the `workspaceFile.ts` section, carry and `collectSessionIds`, and `WorkspaceFileStore.sidekicks()` / `commitSidekicks` / observer snapshot, with tests 1 and the W1 fixture.
   - Hands over: `PersistedSidekicks`, `SidekickRecord`, `commitSidekicks`, and the `observe` snapshot type.
2. **`SidekickService`, IPC and preload.** The window-close bequest change and the projection signatures `(windows, sidekicks)`, with tests 2–4.
   - Hands over: `window.api.{listSidekicks, registerSidekick, saveSidekick, attachSidekick, takeSidekick, removeSidekick, onSidekicksChanged, onSidekickReleased}` and the `SidekickIndexView` shape.
3. **Renderer model.** `SessionMeta.sidekickId`, the ownership clause, persistable ids, autosave, the pool carry, the rehydrate merge, guards, Undo skip, Control and extension exclusion, `fileSessionAsSidekick` and `releaseSidekickRow`, and the `sidekickPanel` pointer in state and persistence. Tests 5–8.
   - Hands over: `fileSessionAsSidekick(sessionId, sidekickId)`, `releaseSidekickRow(sessionId)` and `WorkspaceState.sidekickPanel`.
4. **Sidekick feature state and actions.** The index store and sync, `useSidekickActions` (create, show, openHere, remove, released) and `useSidekickPersistence`. Test 11 and the action half of test 10.
5. **Panel UI and keyboard region.** The surface, panel, splitter and body states, `KeyboardRegionContext`, `useInteractiveOwnership` and the TileLeaf refocus check, the commands and keybindings, and the `isAvailable` guards. Test 9, the panel half of test 10, and the catalog test.
6. **Picker and Hermes polish.** `SidekickPicker`, Hermes readiness ordering and disabling, and the connection name in the header. The picker half of test 10.
7. **Docs and verification.** `ARCHITECTURE.md` (ownership now has two owners; the sidekick index in the deployment/data view), the fixture README, the mutation pass, the full check, and the plan-vs-built table.
8. **Review and PR.** One review round (`pr-review`: one Claude and one Codex reviewer, unless the owner says otherwise). Then the PR, `Fixes #1493`, with the UNCONFIRMED decision list, the manual QA list and the verification boundary. **Stop; no merge without the owner's word.**

## Risks

- **R1. Two writers.** Mitigated by I3 (lease-checked saves) and the transfer-before-release ordering. The residual is a holder that crashes between a change and its debounced save, which loses up to 400 ms of meta, the same as autosave.
- **R2. Rehydrate timing.** A panel that attaches during boot races the first publish. Mitigated by the merge (test 7). The panel also waits for `bootstrapComplete` before attaching, which is belt and braces, documented as such.
- **R3. Hidden composers.** Keyboard region bugs show up as "Enter went to the wrong pane". Mitigated by putting the gate in the one hook every router reads (test 9). The residual is surfaces that bypass `interactive`, found by the build's grep for `focused &&`.
- **R4. Downgrade drops the index** (the §3 ruling). Recoverable through Conversations.
- **R5. A lane-placing command misses its guard.** Mitigated by the catalog walk test (test 8).
- **R6. Narrow terminal view in the panel.** Accepted; agent view is the default.

## Execution notes

(Append-only, dated, during the build.)

- **2026-10-14, Task 1 done** (`6b6f673e`):
  - the file section plus the store queue;
  - a new sanitized capture of the real `workspace.json`, which includes the first real Hermes row, and a documented sidekick mutation of it;
  - the carry mutant is killed by 2 tests.
- **2026-10-14, Task 2.**
  - **Ruling: `attach` claims the router lease itself** (`claimSessionForWindow`) instead of leaving the claim to the renderer's `session:recover`. Why: two windows opening the same sleeping sidekick at once would otherwise both insert the row and race the recover, and the loser would show a raw "owned by another window" error in its pane. Claiming in `attach` makes exactly one winner, and the other gets `owned-elsewhere`. Cost if wrong: a window that wins `attach` but fails to recover keeps the lease, so the sidekick shows as "here" in that window until it retries or the window closes. That is visible and recoverable.
  - **Ruling: observers get sidekicks as a second argument** (`(windows, sidekicks)`), not as a snapshot object. The four projections opt in, and every other listener compiles unchanged.
  - The shared fake store in `remote/workspaceProjection.testSupport.ts` gained `sidekicks()`, so it matches the real store interface.
  - New kill callers: `sidekick.remove` and `sidekick.register-failed`.
- **2026-10-14, Task 2 done** (`d7e98acf`): the service, IPC, preload and window-close carve-out, plus four projections fed with sidekicks. Tests use the real store. The ledger and projection mutants are killed.
- **2026-10-14, Task 3.**
  - **Ruling: sidekick row writes live in `workspace/hook/actions/sidekick.ts`, not `pane.ts`.** Those writes are `fileSpawnAsSidekick`, `adoptSidekickRow`, `releaseSidekickRow` and `setSidekickPanel`, and the module is the only writer of `sidekickId`, following pool.ts's "one place per membership fact" rule. `pane.ts`'s close path stays untouched and still refuses sidekick rows.
  - **Undo Close needs no change.** A sidekick never goes through `closeSession`, so no Undo entry can be captured for one.
  - **`WorkspaceState.sidekickPanel` is optional**, so every existing state literal and test keeps compiling; absent means closed.
  - **The rehydrate merge also carries the held runtime** (the draft typed during boot).
  - **Mutants:**

    | Mutant | Result |
    |---|---|
    | ownership clause | killed |
    | rehydrate merge | killed |
    | replacement carry | killed |
    | lane guard | killed |
    | pin guards | killed, after the test was split so a later write no longer masks the first guard |
    | persistable filter | killed |

  - **Workspace and app-API renderer suites:** 1557/1557.
