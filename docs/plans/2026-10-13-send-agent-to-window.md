# Send an agent to another open window (#1481)

Status: implemented on branch `feat/send-lane-to-window`, PR pending.

## Accepted residuals

- If the source or the target window CLOSES mid-move, the window-close bequest
  may offer a slice that lists the moving session to a window that also lists
  it. `adoptWorkspace` refuses the collision, and that slice comes back on the
  next launch as its own window: a duplicate row, never a lost agent.
- A crash between the target's save and the source's save leaves a duplicate
  row as well (see Protocol).
- A child moved without its parent keeps its `linkedParentId` /
  `orchestrationParentId`. The index shows it as a top-level row (the orphan
  rule in dispatchSelectors). The parent's orchestration tools no longer reach
  it from the old window.

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
- The command is titled **Send to Window…** (id `send-to-window`), with
  "lane" as a keyword. It acts on the focused lane's session from the palette
  and on the clicked row from the right-click menu. Terminals move too: their
  process routes exactly like an agent's. Extension views are excluded, since
  they have no backend and would need the extension running in the other
  window.
- With no other window open, the command still runs: the picker says so and
  names New Window. The renderer cannot know the window count synchronously,
  because that is main's.
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
  - Dropping rows (source drop, target cancel) reuses `workspaceWithoutSessions`
    as is. It already clears lanes and scrubs row metadata, so the first draft's
    `removeMovedSessions` wrapper was deleted as a duplicate.
- Shared seeding: the adoption seed block (runtimes from snapshots, condition
  re-seed, history for live sessions) moves to `hook/ipc/seedIncomingSessions.ts`
  and is used by both adoption and move receipt.
- `hook/ipc/useSessionMoves.ts`:
  - receives moves (queued until bootstrap completes, like adoption)
  - applies moved-out, failed and cancelled messages
  - resolves the promise the sending action awaits
  - exposes `sendSessionToWindow(sessionId, targetWindowId)` on Workspace. It
    returns `{ ok, movedSessionIds, targetWindowNumber }` or
    `{ ok: false, message, reportedByEvent?, uncertain? }`. It lives in the
    hook, not in a separate actions file, because it shares the outgoing-move
    map that main's verdict events settle.
- `refs.pendingSessionMoveIdsRef`, drained by `useAutoSave` beside adoptions.
- UI:
  - uiShell `sendToWindowSessionId` with open and close
  - `SendToWindowSurface` and `SendToWindowDialog` (list of target windows,
    keyboard-first)
  - command `send-to-window` with `contextMenu` placement (group `agent`,
    order 70)
- Control: `agents.moveToWindow`, execution `window`, targeted at the session,
  effect `mutation`. It returns after the source has dropped the rows. A
  failure is `not_started` (refused, or rolled back by main). It is `unknown`
  only when this renderer stopped waiting (its 30 s settle timeout, or an
  unmount) without hearing a verdict.
- `forgetSessionViewState` (formerly `forgetClosedSessionDebugState`) now also
  releases a pending bootstrap timer. Close and move-out both end this window's
  view of a session.
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

## Review dispositions (one round: Codex on correctness, Claude on integration)

| Finding | Verdict | Disposition |
|---|---|---|
| Codex 1 / Claude 1: an in-flight save could confirm a move (or an adoption) whose rows it did not contain, so the source dropped rows that were not durable anywhere | valid (the adoption half predates this PR) | fixed in `856eb5e0`: confirmations are captured at serialization; a regression test fails on the old code |
| Codex 2: waking a parked agent in the target rotated the lease, so a deadline rollback skipped it while the target dropped its rows | valid | fixed in `d883ef63`: rollback also takes back a newer claim by the target window; any other window's claim is still left alone |
| Codex 3: after a rollback the source kept stale readiness and conditions that had been delivered only to the target | valid | fixed in `d883ef63`: rollback marks a router gap, so the source's existing routing-gap repair resyncs |
| Codex 4: the source retiring its Browser Pocket guest unregistered the target's new guest under the same pocket id | valid | fixed in `2d13863d`: only the renderer holding the current registration may unregister it |
| Claude 2: `agents.moveToWindow` accepted extension views | valid | fixed in `45d00581`: the rule now lives in the packet builder and is shared by every entry point |
| Claude 3: moving a child alone silently cuts it off from its parent's orchestration tools | valid (UX) | `45d00581`: the picker and the capability description warn. Redirecting the move to the root owner is a product call, left UNCONFIRMED |
| Claude 4: the picker offered windows that were closing or not ready | valid, low | fixed in `d883ef63` |
| Mutation survivors: failed offer delivery, autosave confirm drain, `moving` map never cleared, outcome split, append ordering | valid gaps | tests added (failed delivery, two moves in a row, in-flight save, `not_started`/`unknown`, clock behind the target's rows) |
| Remaining survivors (pin dedupe, self-link guard, packet version, fresh-id retry, empty drafts, unmount settle, H6/H8/H11/H17/H19) | nits | declined: each guard has a WHY comment, and none has a user-visible failure without another bug first |
| Suspicion: `session:input` and `deliver-prompt` do not check display-window ownership | pre-existing, unproven | not taken up here; no failure sequence was shown for this branch |
| Suspicion: replacement or provider switch during a pending move, and leftover history refs after a move-out | unproven | recorded as residuals in the plan |
