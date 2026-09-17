# Grid Dispatch New-Lane Continuity Plan

**Issues:** #977 (first lane unoccupied on Grid Dispatch entry), #978 (New Lane gated behind Grid Dispatch)
**Branch:** `fix/grid-dispatch-new-lane-continuity`, based on `main` @ `3ddea9a4`

**Goal:** New Lane is runnable from anywhere — when Grid Dispatch is off it
enters the grid directly instead of being invisible — and entering Grid Dispatch
keeps the agent the user was commanding: lane 0 is seeded with the focused
session rather than arriving unoccupied.

## Why the current behavior is wrong

Two independent defects, one user experience: "grid dispatch is weird."

1. **Entry discards the focused agent (#977).** `enterTiledDispatch`
   (`src/renderer/src/workspace/hook/actions/dispatch.ts`) always builds
   all-empty lanes. Classic Dispatch carefully carries `focusedSessionId`
   onto the `dispatchMode` object — and then no lane receives it. The user
   turns Grid Dispatch on from one focused lane and that lane's agent is
   simply gone from the layout.

2. **New Lane is triple-gated (#978).** `new-tiled-lane` has
   `surface: 'dispatch'` (palette-invisible outside Dispatch),
   `when: canInsertLaneInFocusedRow` (false without `dispatchMode.tiled`),
   and a `run` that bails without `tiled`. The only path to a lane is the
   Grid Dispatch shape-editor modal — bulk setup standing in for the
   incremental gesture.

### Why seeding does not violate #681

#681 removed **bulk auto-fill**: `buildAutoLanes` claiming next-unclaimed
agents for every lane on enter and growth. Its principle: *a new slot is a
request for SPACE, not for a particular agent.* Seeding lane 0 with the
**already-focused** session is not a prediction from the index — it is
continuity with the pane the user was just commanding. No unclaimed agent is
consulted; the other lanes stay empty exactly as #681 requires. The rejected
alternative (render-time healer) is the mechanism #681 deleted; the fix lives
solely in the entry reducer.

### Why the wake-before-place rule (#690) is not violated

Every path that moves a *new* session into a lane wakes it first
(`selectTiledLaneSession`). The seed is the session whose pane is already
mounted — classic Dispatch renders the focused agent's view, and the grid's
focused tile is mounted by definition. A stale-but-recorded id (e.g. a
rehydrated pane whose respawn failed) is guarded below and otherwise behaves
exactly as it does in classic Dispatch today; no new dead-pane path opens.

## Changes

1. **`src/renderer/src/workspace/dispatch/tiledDispatchSelectors.ts`** — new
   pure resolver `dispatchEntrySeedSessionId(state)`:
   `dispatchMode?.focusedSessionId ?? activeTab?.focusedSessionId`, returned
   only when the session exists in `state.sessions` and is not buried.
   Buried guard mirrors the control plane's `lane-select` admission; a
   missing/hibernated id returns null and the lane stays empty (honest, no
   worse than today). Lives with the other lane-content helpers so lane
   construction rules stay in one file.

2. **`src/renderer/src/workspace/hook/actions/dispatch.ts`** —
   `enterTiledDispatch` seeds lane 0 via `withLaneSession` when the resolver
   returns an id. Only lane 0; only on entry. `focusedLane: 0` unchanged, so
   the seeded lane is the focused lane.

3. **`src/renderer/src/features/workspace/commands/layoutCommands.ts`** —
   `new-tiled-lane`:
   - `surface: 'app'` so it is visible from the grid, classic Dispatch, and
     Grid Dispatch alike.
   - `when`: `true` when `tiled` is absent (the entry path has no caps to
     check — `[2]` is always legal); otherwise today's
     `canInsertLaneInFocusedRow`.
   - `run`: when `tiled` is absent, `await workspace.enterTiledDispatch([2])`
     — lane 0 is the seeded focused agent, lane 1 is the new empty lane,
     focus stays on lane 0 (the command's "current lane stays focused"
     contract). No `insertTiledLaneRight` call: the shape already contains
     the new lane. When `tiled` is present, behavior is byte-for-byte
     today's.
   - Description text updated to say it can be run from anywhere and enters
     Grid Dispatch when it is off.

4. **Tests:**
   - `tiledDispatchSelectors.test.ts`: resolver contract — classic focus
     wins, grid focus is the fallback, buried/absent ids return null.
   - `layoutCommands.renderer.test.ts`: the classic-Dispatch `when` case
     flips from `false` to `true`; a no-`tiled` `run` calls
     `enterTiledDispatch` with `[2]` and does not call
     `insertTiledLaneRight`; existing tiled-path cases unchanged.
   - Seeding in the reducer is covered through the resolver + the thin
     wiring rule (helper output → `withLaneSession` on lane 0); the hook
     harness cost of rendering `useDispatchActions` would buy no additional
     contract.

## Out of scope

- Preserving a full Grid Dispatch layout across `exitDispatchMode` →
  re-enter (lane weights, row projects). Flagged as a follow-up; the user
  did not report it.
- Migrating the shape-editor modal or the `tiled-dispatch` bulk command.

## Verification

- `npx vitest run` on: `tiledDispatchSelectors`, `gridShape`,
  `gridShapeMutations`, `gridPersistence`, `layoutCommands.renderer`,
  `dispatchSelectors`, `rowScopedRows`.
- Typecheck + lint per `package.json` scripts.
- Full `npm test` if runtime allows.

## Commit / PR shape

- `docs(dispatch): plan Grid Dispatch new-lane continuity` (this file, first
  commit; Refs #977, Refs #978)
- `fix(dispatch): seed the focused agent into lane 0 on Grid Dispatch entry`
  (Fixes #977)
- `feat(dispatch): make New Lane enter Grid Dispatch from anywhere` (Fixes #978)
- PR: `fix(dispatch): make New Lane always available and keep the focused agent on Grid Dispatch entry`
