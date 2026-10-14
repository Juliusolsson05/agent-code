# Send an agent to another open window (#1481)

Status: in progress. Branch `feat/send-lane-to-window`.

## Outcome

With two or more windows open, the user can move the agent in the focused
lane (or any agent, from the Sessions right-click menu) to another window.
Nothing restarts. Root Agent Code Management agents and the external operator
can do the same through `ac_agents_move_to_window`.

## Rulings (owner, 2026-10-13)

1. **Move, not copy.** The agent leaves the source window. Its process,
   conversation, draft, pin, title and MCP choices are carried over unchanged.
2. **Destination project.** The agent joins a target-window project that
   already holds the same folder. Otherwise a new project tab is created.
3. **Children move with it.** Linked agents and orchestration workers move
   too, transitively.
4. **Source lane.** The lane the agent leaves is cleared, the same as Clear
   Lane (⌥⌫). It is not removed.

Defaults I chose (UNCONFIRMED, listed in the PR):

- The moved agent appears in the target window's focused lane. The target
  window is NOT raised, because the person sending usually keeps working where
  they are. The source shows a toast naming the target.
- The command is titled **Send Agent to Window…**, with "lane" as a keyword.
  It acts on the focused lane's agent from the palette and on the clicked
  agent from the right-click menu, so "Agent" is accurate for both.
- Each window in the picker is labelled `Window N`, followed by its project
  titles and agent count, read from that window's saved workspace (at most one
  autosave old).

## Evidence (verified on origin/main 1bcba637, do not re-derive)

- The only cross-window handover today is a window **close**:
  - `main/index.ts` `setWindowClosedObserver` calls
    `transferSessions(sessionsOwnedBy(closed), survivor)` and
    `recordPendingBequest`, then sends `workspace:adopt` with the closed
    window's slice.
  - The survivor merges it (`adoptWorkspace`), seeds runtimes from
    `getBackendSnapshot`, re-seeds conditions, and loads history for live
    sessions (`useWorkspaceAdoption`).
  - It confirms only after a DURABLE save (`useAutoSave` drains
    `pendingAdoptionWindowIdsRef`). Then main drops the slice
    (`ipc/window.ts`).
- Routing (`sessionWindowRouter`):
  - Every session event goes through `sendToSessionWindow` (`forwarder.ts`),
    including terminal output.
  - `claim` refuses a second live window, and only `transfer` moves a claim.
  - Leases are compared by identity, so a delayed rollback can only undo the
    exact claim it made.
- Main never kills a session because a slice stopped listing it.
  `commitDurableOwnership` only retires committed Codex handoff predecessors.
  So the source dropping rows after the target's save is safe.
- Removing rows without killing: `workspaceWithoutSessions` (pool.ts) drops
  rows, pins, emptied projects and row bindings. `clearTiledLaneSessions`
  clears lanes. Both are already used by close and merge.
- Ownership edges: `linkedParentId ?? orchestrationParentId`
  (`bulkClose.ts ownershipDepth`, `dispatchSelectors`).
- Same-folder project: `findTabsHoldingDirectory(state, cwd)` (queries.ts),
  which compares cwd strings as stored.
- Tab ids are window-local `randomUUID()`s. `adoptWorkspace` REFUSES a tab or
  session id collision. So a new project in the target must get a fresh id,
  or a later window-close merge of the two windows would be refused.
- Right-click menu items are commands with `contextMenu` metadata, evaluated
  against `ctx.target` (`buildSessionContextMenu`).
- Window list: `app.windows` (`main/window/control.ts`) numbers windows by
  `listWindowIds()` order. All BrowserWindow titles are the same, so titles
  cannot tell windows apart.

## Protocol

```
source A                      main                           target B
sendSessionToWindow ──► window:send-sessions
                         validate (A owns or nobody owns;
                           B registered, ready, ≠ A)
                         claim/transfer routing → B
                         pending[moveId] + deadline
                         ──► workspace:receive-sessions ──► receiveMovedSessions
                                                           seed runtimes, publish,
                                                           select into focused lane
                                                           autosave (durable)
                         ◄── window:session-move-complete ◄─┘
◄── workspace:sessions-moved-out
drop rows (no kill), clear lanes
```

- **Refusal** (target cannot merge: collision, bad packet): B sends
  `window:session-move-refused`. Main hands routing back to A, but only leases
  that are still the ones it made. Leases that were unowned before are
  released. A receives `workspace:session-move-failed` and keeps everything.
- **Deadline** (20 s, no confirm, e.g. a read-only store or a crashed target
  renderer): same rollback, plus `workspace:session-move-cancelled` to B, so B
  removes whatever it merged (rows only, never a kill). A late confirm is
  ignored because the pending entry is gone.
- **Crash between B's save and A's save:** both slices list the agent. Next
  launch shows a duplicate row whose claim is refused in one window. That is a
  duplicate, never a lost agent. Accepted residual.
- A move of a session that is mid-move is refused in both renderer and main.

## Change

### Main

- `main/window/sessionMove.ts`: `SessionMoveCoordinator`.
  - Pure state with injected routing, send and timer functions, so the
    authority and rollback rules are unit-testable without Electron.
  - Handles start / complete / refuse / deadline. Confirmations are checked
    against the target's window id and renderer generation, the same rule as
    adoption.
- `windowRegistry.ts`: `transferSession(sessionId, to)` returns the new lease.
  `transferSessions` is reduced to a loop over it.
- `ipc/window.ts`: `window:move-targets`, `window:send-sessions`,
  `window:session-move-complete`, `window:session-move-refused`.
- `storage/workspaceFile.ts`: `describeWindowWorkspace(file, windowId)` returns
  project titles and session count for the picker labels. It reads the same
  record shape `collectSessionIds` already reads.

### Preload

- The matching `window.api` methods and listeners.

### Renderer

- `workspace/sessionMove.ts` (pure):
  - `collectMoveSubtree` (transitive, cycle-safe)
  - `buildSessionMovePacket` (rows, the projects they belong to, pins, drafts,
    normalized MCP domains as autosave writes them)
  - `receiveMovedSessions` (collision refusal, per-source-project resolution
    to a same-folder tab or a fresh tab, appended `joinedAt`, pins appended)
  - `removeMovedSessions` (source drop and target cancel)
- Shared seeding: the adoption seed block (runtimes from snapshots, condition
  re-seed, history for live sessions) moves to `hook/ipc/seedIncomingSessions.ts`
  and is used by both adoption and move receipt.
- `hook/ipc/useSessionMoves.ts`:
  - receives moves (queued until bootstrap completes, like adoption)
  - applies moved-out, failed and cancelled messages
  - resolves the promise the sending action awaits
- `hook/actions/windowMove.ts`: `sendSessionToWindow(sessionId, targetWindowId)`
  returns `{ ok, moved, targetWindowNumber } | { ok: false, reason }`.
- `refs.pendingSessionMoveIdsRef`, drained by `useAutoSave` beside adoptions.
- UI:
  - uiShell `sendToWindowSessionId` with open and close
  - `SendToWindowSurface` and `SendToWindowDialog` (list of target windows,
    keyboard-first)
  - command `send-agent-to-window` with `contextMenu` placement
- Control: `agents.moveToWindow`, execution `window`, targeted at the session,
  effect `mutation`. It returns after the source has dropped the rows.
- Copy:
  - the Root management dialog no longer says attach / detach / bury
  - `rootManagementInstructions` counts moving between windows as placement
  - `app.describe` mentions the capability

## Tests

- Main coordinator: start authority (foreign owner refused, self target
  refused, unready target refused), confirm authority (wrong sender or stale
  generation ignored), refusal rolls back only current leases, deadline cancels
  both sides, late confirm ignored.
- Renderer pure:
  - subtree includes transitive linked and orchestration children, and is
    cycle-safe
  - packet round trip
  - receive joins a same-folder tab, else mints a new tab id, and refuses
    collisions
  - remove clears lanes, pins and emptied projects
- Catalog pins (135 → 136) and the keybinding check.

## Verification

- `npx tsc -b`, the relevant vitest files, then the full suite once at the end.
- Manual app QA is owed: per house rule, the app is not launched by the agent.
