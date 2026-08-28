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

It is worse than "last in the grid slice": `resolveDispatchTerminalSplitTarget`
resolves the split anchor as `targetLeafId ?? focusedLeafId ?? leafIds[0]`. The
focused Dispatch row is normally a *detached* agent with no grid leaf, so the
anchor degrades to `leafIds[0]` and the terminal is spliced beside the FIRST
grid leaf. That is the literal "pinned to the top" the user reports.

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

1. **Ordering (the actual bug).** A selector test over
   `buildVisibleDispatchRows`: given a grid agent plus two detached agents,
   a terminal created through the Dispatch flow must sort *after* the agents,
   not before. Fails if anyone reintroduces a grid insert for Dispatch
   terminals, or flips the grid/detached concatenation order.

2. **#366 target resolution survives the deleted resolver.** The existing
   `resolveDispatchSpawnTarget` tiled-lane tests already assert project/cwd
   come from the focused lane. Extend the terminal-specific coverage that
   `resolveDispatchTerminalSplitTarget` used to own into a case proving the
   detached record is filed under the focused lane's tab with that lane's cwd
   — the same regression #366 was opened for, one layer down.

3. **Lane placement.** A Dispatch terminal created with a focused tiled lane
   must occupy that lane (`applyDispatchSpawnFocus`), not lane 0.

No test is added merely to cover the deleted functions; deleting dead code
does not need its own assertion.

Full check: `npx tsc -p tsconfig.node.json --noEmit` and
`npx tsc -p tsconfig.web.json --noEmit` (electron-vite build and vitest do not
type-check), plus the workspace/dispatch vitest suites.

## Risks and limitations

- A Dispatch terminal is now hibernated across restart like any detached
  session: its shell is re-attached (tmux) or respawned when its lane first
  renders, not at launch. Intended, and consistent with agents.
- `paneLabelForSession` indices for a tab containing a Dispatch terminal
  shift, because `resolveTabSessions` also orders grid-then-detached. This is
  the same coordinate the Dispatch list shows, so the two stay in agreement.
- Terminals created OUTSIDE Dispatch (normal grid mode, ⌥T) are untouched:
  they remain grid leaves. Only the Dispatch creation surface changes.
