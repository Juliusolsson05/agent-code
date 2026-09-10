# Grid Dispatch First-Lane Strip Plan

**Issue:** #850 (regression from #687 / #681)
**Branch:** `fix/grid-dispatch-first-lane-strip`, based on `origin/main` @ `48ea6912`

**Goal:** Every Grid Dispatch lane, including the first (leftmost) lane of each
row, gets its own compact index strip (`DispatchMiniList`), so swapping the
agent in any lane is one click on a selector that belongs to that lane.

## Why the first lane lost its selector

Before Grid Dispatch rows (parent of `524671b2`), the full index list beside the
lanes always wrote lane 0 (`setTiledLaneSession(0, …)`). The first lane skipping
the strip was correct then: the index *was* lane 0's selector, and a strip would
have been a second selector for the same lane.

`524671b2` (#687) gave every row its own index and retargeted that index to
`focusedLaneInRow ?? start`, meaning whichever lane of the row is focused. It kept
the `column > 0` strip gate and its comment. From then on the first lane had no
selector of its own. Changing it takes two steps (click into the lane to move
focus, then pick from the index), while every other lane takes one click on its
strip.

The fix keeps the index's follow-focus behavior, which the user chose on purpose,
and gives the first lane its strip back. It does not revert the index to lane-0-only.

## Changes

All under `src/renderer/src/workspace/dispatch/`.

1. **`TiledDispatchLayout.tsx`**
   - Render `DispatchMiniList` for every lane: drop the `column > 0 &&` gate on
     the strip. Keep the gate on `LaneBoundary`, since the first lane has no left
     neighbour to resize against.
   - Replace the "The row's FIRST lane has no strip" WHY comment with the reason
     every lane has one: the index follows focus, so it cannot be any single
     lane's dedicated selector.
   - Empty-lane hint:
     - Drop the `column === 0` "Pick an agent from the index" branch, because
       every lane now has a strip.
     - Delete the dead `gridRow.projectTabId` branch, so every row shows
       "Pick an agent from the strip, or press ⌥↓ for the top of the index".

     > **Amended during implementation (2026-09-10).** The first draft of this
     > plan said to *fix* that read to `projectTabIds`, on the premise that ⌥↓
     > takes the top of the global index and so "the top of the index" is false
     > in a bound row. That premise is out of date. `524671b2` split the copy
     > while ⌥↓ still walked the global list (`dispatchRows(workspace)` at that
     > commit). `29ecd829` then made ⌥↓ walk the focused row's own filtered list
     > (`tiledRowScopedRows` in `useKeybinds.ts`), which makes "the top of the
     > index" true in a bound row too. The stale read happened to show that copy
     > anyway, because `normalizeGridShape` folds `projectTabId` away. Fixing the
     > read would have withheld a true promise, so the branch is deleted. Bound
     > rows see no change. The hint is copy, so no test pins it; a WHY comment at
     > the hint says not to re-add a binding branch while ⌥↓ is row-scoped.
2. **`DispatchMiniList.tsx`**
   - Prop type `Pick<DispatchGridRow, 'projectTabId' | …>` becomes
     `'projectTabIds'`. That is the field `rowScopedRows` actually reads. Runtime
     behavior is already right because the full row object is passed; only the
     declared contract is stale.

## Tests (`gridDispatchLayout.renderer.test.tsx`)

Written first, and each one must fail on `origin/main` before the fix:

- **Every lane has a strip.** A 2×2 grid renders 4 strips; a `[3, 1]` grid
  renders 4 strips. These replace the two tests that pinned "first lane has no
  strip".
- **The first lane's strip selects into the first lane, not the focused lane.**
  With focus on lane 1 of row 0, clicking lane 0's strip calls
  `selectTiledLaneSession(0, …)` and `setTiledFocusedLane(0)`. This is the
  one-click navigation the issue is about.
The `DispatchMiniList` mock reports its lane's selection and forwards a click to
the layout's real `onSelect` closure, so the tests can tell lane 0's strip from
the others and observe which lane the layout writes. Also update the stale
"once each row's first lane lost its strip" comment on the row-targeting test.
That test's claim still holds.

(The first draft also listed a bound-row hint test. It was dropped with the
premise it relied on; see the amendment under Changes.)

## Out of scope

- Classic single-pane Dispatch (`DispatchLayout` without `tiled`). Its index is
  still its only pane's selector.
- Index click semantics, keybindings, `DispatchAgentList`.

## Verification

On Node 24 (`.nvmrc`; Node 25 breaks happy-dom's `localStorage`):

- `NODE_ENV=test npx vitest run --project renderer src/renderer/src/workspace/dispatch/`
  shows RED before the fix and GREEN after.
- `npm run typecheck` (vitest and electron-vite do not type-check).
- One full `npm test` before opening the PR.

The app is not launched. The layout contract is proven at the rendered-layout
level, which is where the #673 post-mortem says a layout fix has to be proven.
