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

### Why the wake-before-place rule (#690) is satisfied by waking the seed

> **Corrected after review (2026-09-16, PR #979 review).** The first draft of
> this section argued the seed "is the session whose pane is already mounted
> … live by definition," so no wake was needed. That is a heuristic, not a
> definition: classic Dispatch mounts the focused agent's view WITHOUT waking
> it (`DispatchLayout.tsx` calls `renderWorkspaceLeaf` directly), a restart
> leaves the persisted focus on a deliberately-unrespawned detached agent,
> and `dispatch.ts` itself documents that grid-placed is "NOT a guarantee that
> it is live." Writing that id into a lane raw is exactly the #690 bug class
> (dead pane that rejects the first prompt). The implemented rule below wakes
> detached seeds before the write.

Every path that moves a *new* session into a lane wakes it first
(`selectTiledLaneSession`), and the seed now does too: a detached seed is
`ensureSessionLive`-woken BEFORE `enterTiledDispatch`'s state write (reason
`grid-dispatch.entry-seed`), using the same detached predicate as
`selectTiledLaneSession`. Grid-placed seeds skip the wake for the same reason
that gesture does — rehydrate already respawned them. The guard set on the
resolver itself is *recorded and non-buried* (NOT a liveness check):
rejecting detached ids outright would kill the common case, because in an
ordinary session every dispatch agent is detached. A failed wake costs the
seed, never the entry; a focus that moves during the (up to 30s cold) wake
drops the seed rather than raw-writing an unvalidated id from inside the sync
updater.

## Changes

1. **`src/renderer/src/workspace/dispatch/tiledDispatchSelectors.ts`** — new
   pure resolver `dispatchEntrySeedSessionId(state)`:
   `dispatchFocusedSessionId(dispatchMode) ?? activeTab?.focusedSessionId`,
   returned only when the session exists in `state.sessions` and is not
   buried. Buried guard mirrors the control plane's `lane-select` admission;
   a missing id returns null and the lane stays empty (honest, no worse than
   today). Lives with the other lane-content helpers so lane construction
   rules stay in one file.

   > **Amended during implementation.** The draft read the raw
   > `dispatchMode?.focusedSessionId`; the shipped resolver goes through the
   > tiled-aware `dispatchFocusedSessionId` instead, so re-entering over an
   > existing grid carries the focused LANE's agent. Strictly better
   > continuity, same precedence otherwise.

2. **`src/renderer/src/workspace/hook/actions/dispatch.ts`** —
   `enterTiledDispatch` seeds lane 0 via `withLaneSession` when the resolver
   returns an id, after waking a detached candidate (see the corrected #690
   section above). Only lane 0; only on entry. `focusedLane: 0` unchanged, so
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
   - Control-plane contract updated to match: `dispatch.configure`'s
     description and the workspace `controlReference` cautions now state
     that a grid entered from Dispatch seeds lane 0 with the focused agent
     (review finding: the seeding silently changed that external surface).

4. **Tests:**
   - `entryContinuity.renderer.test.tsx` (hook harness over the real
     `useDispatchActions`, eagerly-applying `setState`): seeding contract —
     classic focus seeds lane 0 and only lane 0, grid pane is the fallback,
     classic focus wins, tiled re-entry carries the focused lane, and
     buried/absent/no-focus degrade to empty lanes; wake contract — detached
     seed wakes before the write, failed wake enters unseeded with a toast,
     grid-placed seed skips the wake, focus moved during the wake drops the
     seed.
   - `layoutCommands.renderer.test.ts`: the classic-Dispatch `when` case
     flips from `false` to `true`; a no-`tiled` `run` calls
     `enterTiledDispatch` with `[2]` and does not call
     `insertTiledLaneRight`; existing tiled-path cases unchanged.

   > **Amended during implementation.** The draft planned selector unit tests
   > in a `tiledDispatchSelectors.test.ts` and argued a hook harness "would
   > buy no additional contract." Overruled: the bug (#977) lives in the
   > reducer's wiring, and the `laneSelectionWake.renderer.test.tsx`
   > precedent showed the harness cost is one `renderHook` — the delivered
   > tests pin seed→lane-0 AND the wake ordering through the real action,
   > which selector tests alone could not.

## Out of scope

- Preserving a full Grid Dispatch layout across `exitDispatchMode` →
  re-enter (lane weights, row projects). Flagged as a follow-up; the user
  did not report it.
- Migrating the shape-editor modal or the `tiled-dispatch` bulk command.

## Verification

- `npx vitest run` on: `entryContinuity.renderer`, `laneSelectionWake.renderer`,
  `gridShape`, `gridShapeMutations`, `gridPersistence`,
  `layoutCommands.renderer`, `dispatchSelectors`, `rowScopedRows`, and the
  command-palette suites (catalog, pickerVisibility, keybindingBaseline) for
  the surface change.
- `npm run typecheck`, `npm run check:keybindings`, `npm run test:contract`.
- Full `npm run test:unit` (one pre-existing environment failure in
  `imageAttachment.test.ts`, reproduced on unmodified main).

## Commit / PR shape

- `docs(dispatch): plan Grid Dispatch new-lane continuity` (this file, first
  commit; Refs #977, Refs #978)
- `fix(dispatch): seed the focused agent into lane 0 on Grid Dispatch entry`
  (Fixes #977)
- `feat(dispatch): make New Lane enter Grid Dispatch from anywhere` (Fixes #978)
- PR: `fix(dispatch): make New Lane always available and keep the focused agent on Grid Dispatch entry`
