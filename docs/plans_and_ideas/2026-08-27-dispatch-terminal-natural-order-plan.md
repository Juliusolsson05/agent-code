# Dispatch terminals in the natural row flow

Issue: #671. Related: #152, #202, #248, #266, #366.

## Problem

A terminal created from Dispatch always renders at the top of its project
group, above every agent, regardless of when it was created. Agents created
from the same surface append in creation order. The list therefore stops
being a chronological record of what the user opened.

## Why it happens

Two independent facts combine:

1. `splitFocused` has **two** Dispatch branches (`pane.ts`):
   - `kind !== 'terminal'` → detached dispatch session (`detachedSessions[id]`).
   - `kind === 'terminal'` → grid leaf via `splitLeaf` into `tab.root`.

2. `buildDispatchGroups` builds every project group as
   `[...gridSessionIds, ...detachedSessionIds]` — grid leaves unconditionally
   before detached rows.

Every Dispatch agent is detached; every Dispatch terminal is a grid leaf.
The ordering is structural, not incidental.

The concatenation is the entire cause, and it is sufficient on its own: the
terminal's position *within* the grid slice never mattered, because the whole
grid slice precedes the detached rows the user's agents live in.

An earlier draft of this plan blamed `resolveDispatchTerminalSplitTarget`
degrading its anchor to `leafIds[0]`. That was wrong and is recorded here so it
is not re-derived: the anchor is `targetLeafId ?? focusedLeafId ?? leafIds[0]`,
and `focusedLeafId` is `tab.focusedSessionId`, which `focusDispatchSession`
deliberately never writes — so it stays a real grid leaf and the `leafIds[0]`
fallback is effectively unreachable. `splitLeaf` also inserts *after* its
anchor, so a Dispatch terminal could not occupy the first leaf position even
then. Verified by executing the pre-fix path: with grid `[g1,g2,g3]` the
terminal lands at the END of the grid slice — still above every detached agent,
which is the actual complaint.

## Why the old justification no longer holds

pane.ts carried a `WHY terminals still enter the grid from Dispatch` comment
citing tmux name, resize lifecycle, undo/close history, and persistence as
leaf-based. Every one of those is **session**-scoped, and a detached terminal
is already a supported state reachable today:

- `detachFocusedToDispatch` has never excluded terminals — a user can already
  park a terminal in Dispatch by hand.
- `renderWorkspaceLeaf` renders `kind === 'terminal'` in a Dispatch lane; the
  lane path is not grid-aware.
- `TerminalLeaf` wakes its own backend on mount through
  `ensureSessionLive(sessionId, 'terminal-leaf.mount')`, and `ensureSessionLive`
  passes `recoverTmuxName` for terminals. Hibernation therefore resolves the
  same way it does for a detached agent: on first render in a lane.
- `undoClose` already threads `recoverTmuxName` for detached entries, with a
  comment explicitly anticipating "a future surface that allows detached
  terminals".
- `findTerminalSessionInTab`'s own comment already states that the project
  terminal "is allowed to be detached into Dispatch now".

The single real behavioural difference is that detached sessions are **not**
respawned during rehydrate (deliberate anti-fork-bomb policy). For a terminal
that means its PTY comes back when its lane first renders rather than at
launch — which is the existing, intended behaviour for a hand-detached
terminal, and is strictly better than spawning shells nobody asked for.

## The change

### 1. `pane.ts` — one Dispatch branch in `splitFocused`

Collapse the two `dispatchSnapshot.dispatchMode` branches into a single
kind-agnostic branch:

- Target resolution: `resolveDispatchSpawnTarget` for every kind. This is what
  preserves the #366 invariant (project tab and cwd both come from the focused
  lane / focused Dispatch row) without a terminal-specific resolver.
- cwd chain unchanged from the agent branch: `continuation?.cwd` →
  `target.cwdSessionId` → `tab.focusedSessionId` → first leaf with a cwd.
- Spawn: pass `resumeSessionId` / `builtInMcpDomains` straight through.
  `sessionActions.spawn` already gates both on `kind !== 'terminal'`, so the
  call site does not need a second guard that could drift from it.
- Commit: write a `detachedSessions` record + `applyDispatchSpawnFocus`, so the
  new session lands in the focused tiled lane exactly as an agent does.
- Keep the terminal branch's orphan guard and apply it to **both** kinds: if
  the resolved tab vanished between spawn and commit, kill the backend instead
  of leaking a session that is in `state.sessions` but in no tree and no
  detached record. The agent branch silently had that leak; merging is the
  moment to fix it rather than preserve it in a shared path.

### 2. Extract the detached-record construction

`splitFocused` and `createDetachedDispatchAgent` build the identical
`DetachedSessionRecord` literal. Extract one `detachedDispatchRecord()` helper
so the durable shape has a single definition. This is in blast radius (the
merged branch is one of the two copies) and removes a real duplication.

### 3. Delete what the merge makes dead

- `resolveDispatchTerminalSplitTarget` + `DispatchTerminalSplitTarget`
  (`dispatchSelectors.ts`). Its only purpose was picking a grid split anchor.
- `findTerminalSessionInTab` (`dispatchSelectors.ts`) and
  `findTerminalInLatestTab` (`hook/actions/dispatch.ts`) — already dead before
  this change; leftovers from the removed Dispatch project-terminal column.
  Confirmed by grep across `src/` and `packages/`: the only reference to
  `findTerminalSessionInTab` is the equally uncalled `findTerminalInLatestTab`.

### 4. Callers and copy

- `NewAgentPlacementOverlay` keeps routing Terminal through `splitFocused`,
  but its comment must stop claiming terminals become grid leaves.
- The `New Terminal Right/Below` palette descriptions claim the terminal
  "attaches to the focused row or lane's project grid". That is now wrong;
  they become Dispatch rows in the focused lane's project.

## Verification

Behaviour worth protecting, and the plausible failure each test catches:

These MUST drive `splitFocused` itself, not assert selector output over a
hand-written fixture. A first attempt did the latter and was worthless: it
built the detached record by hand and then checked that `buildDispatchGroups`
concatenates, which passes identically against the unfixed code. The bug was
never in the selectors — `[...grid, ...detached]` was always correct — so the
spawn action is the only unit whose behaviour actually changed. Every test
below was confirmed to FAIL on `main` and pass on this branch.

`mcpDomainContinuity.renderer.test.tsx` already mounts `usePaneActions`; that
setup is extracted to `hook/actions/testing/paneActionsHarness.tsx` so both
suites share one copy. Its mock `spawn` registers `SessionMeta` the way the
real one does — without that, every selector filtering on
`state.sessions[...] !== undefined` drops the new session and placement
assertions pass against a session that never appeared.

1. **Ordering (the actual bug).** ⌥T in Dispatch must leave `tab.root`
   untouched, file a detached record, and land the terminal *after* the agents
   in `buildVisibleDispatchRows`. Fails if anyone reintroduces the grid insert.

2. **Lane placement.** A Dispatch terminal created with a focused tiled lane
   must occupy THAT lane (`applyDispatchSpawnFocus`), leaving lane 0 alone.

3. **Normal mode is untouched.** ⌥T outside Dispatch still splits the grid, so
   "merge the flows" cannot quietly become "terminals never enter the grid".

4. **#366 survives the deleted resolver.** `resolveDispatchSpawnTarget` with a
   DETACHED session in the focused lane must keep that session's cwd — the
   normal Dispatch state, and the case the deleted
   `resolveDispatchTerminalSplitTarget` test used to own. Without it, a ⌥T
   fired beside a worktree agent could silently spawn in the parent repo.

5. **Undo-close for detached sessions** (see below).

No test is added merely to cover the deleted functions; deleting dead code
does not need its own assertion. An earlier draft also shipped a test asserting
that a grid-inserted terminal sorts first — dropped, because it only restated
`buildDispatchGroups`' concatenation and froze a residual behaviour as a
contract.

Full check: `npx tsc -p tsconfig.node.json --noEmit` and
`npx tsc -p tsconfig.web.json --noEmit` (electron-vite build and vitest do not
type-check), plus the workspace/dispatch vitest suites.

## Undo-close, and why this change forced it

Review caught that moving Dispatch terminals onto the detached path silently
removed a recovery affordance. `closeSession` captured undo entries only in its
`owningTab` arms; the detached arm pushed nothing.

For an agent that was merely inconvenient. For a terminal it is data loss:
closing one stops the attach PTY but leaves the tmux session alive, and because
the session row is gone from `workspace.json`, the next launch's tmux reconcile
sees a live session with no persisted owner, classifies it as an orphan, and
kills it (`src/main/tmux/tmuxRecovery.ts`). Before this change the same terminal
was a grid leaf, so ⌘⇧T restored it with `recoverTmuxName` and the scrollback
came back.

The fix adds a third `ClosedEntry` variant, `'detached'`, carrying the
`SessionMeta` and the `DetachedSessionRecord` verbatim. It could not reuse
`ClosedPane`, whose every placement field (direction, ratio, sibling anchor) is
a grid concept a detached row has no answer for. Storing the record verbatim is
what preserves `detachedAt` — the only thing ordering rows inside a project
group — so undo puts the row back where it was instead of at the bottom of the
list. Restoring is refused as `stale` when the project tab is gone, because a
record filed under a dead tab renders in no Dispatch group at all and would
leave a live backend the user cannot see or close.

This also gives detached AGENTS an undo they never had.

## Risks and limitations

- A Dispatch terminal is now hibernated across restart like any detached
  session: its shell is re-attached (tmux) or respawned when its lane first
  renders, not at launch. Intended, and consistent with agents.
- `paneLabelForSession` indices for a tab containing a Dispatch terminal
  shift, because `resolveTabSessions` also orders grid-then-detached. This is
  the same coordinate the Dispatch list shows, so the two stay in agreement.
- Terminals created OUTSIDE Dispatch (normal grid mode, ⌥T) are untouched:
  they remain grid leaves. Only the Dispatch creation surface changes.
