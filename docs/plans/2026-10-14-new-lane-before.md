# New Lane Before

**Status:** implemented on this branch. Owner accepted the defaults below
("build it out", 2026-10-14).

## Problem

**New Lane** (`new-tiled-lane`) can only insert an empty lane to the
**right** of the focused lane. To get an empty lane to the left of an agent
you have to focus the lane to its left and run New Lane there. That fails
when the agent is in the row's first lane, because no lane sits to its left.
The only other route is Stage Shape… and re-selecting agents, which disturbs
the layout you wanted to keep.

## Feature

A new command, **New Lane Before** (`new-tiled-lane-before`), inserts one
empty lane immediately to the **left of the focused lane**, in the same row.
It behaves the same as New Lane in every other way:

- Only the focused lane's row gets longer, and the other rows stay as they
  are (the ragged-shape contract).
- The new lane starts empty, because adding a lane asks for space, not for an
  agent (#673).
- **Focus stays on the agent you were in.** That agent moves one index to the
  right, so `focusedLane` becomes `focusedLane + 1`. If focus kept the old
  index, it would silently land on the empty new lane and retarget every
  keyboard command.
- It uses the same caps (`MAX_DISPATCH_TILES` per row, `MAX_DISPATCH_LANES` in
  total) and the same `when` gate, and shows the same "New lane created"
  toast on the source session.
- `surface: 'app'`, so it can be reached from every surface, like New Lane
  (#978).

## Design

### 1. Pure reducer: `gridShape.ts`

Replace `insertLaneRightIntoGrid(tiled, laneIndex)` with
`insertLaneIntoGrid(tiled, laneIndex, side: 'before' | 'after')`:

- `insertAt = side === 'after' ? laneIndex + 1 : laneIndex`.
- The row lookup, caps, weights and focus shift do not change. The helper
  already shifts `focusedLane` when `insertAt <= focusedLane`. Its own comment
  says it was "deliberately more general" for exactly this case, so the
  before-path needs no new focus logic.
- `insertLaneWeight(grid, rowIndex, insertAt)` already averages the target row
  and splices at `insertAt`. `insertAt === laneIndex` is still inside the same
  row (the row's start index), so the weight goes into the correct row.

Two exported functions that differ by `+1` would duplicate the cap and weight
logic. That is the drift this reducer exists to prevent, so the plan uses one
function with a `side` argument instead. All callers (the hook action, two
test files) are in this repo and get updated in the same PR.

### 2. Hook action: `workspace/hook/actions/dispatch.ts` + `hook/index.ts`

Rename `insertTiledLaneRight(laneIndex)` to
`insertTiledLane(laneIndex, side)`. It keeps the same synchronous
"report the reducer's actual admission" contract. Update the
`insertDispatchRowBelow` comment that cites it by name.

### 3. Command: `features/workspace/commands/layoutCommands.ts`

- Pull New Lane's `run` body out into a local
  `runInsertLane(workspace, side)`. Both commands then share the re-check,
  the strict source-target resolution and the toast-on-source behaviour.
- New Lane calls it with `'after'` and keeps its id, title and bindings.
- New Lane Before calls it with `'before'`. The toast condition compares
  `sourceTarget.laneIndex === laneIndex`, captured **before** the insert, so
  it still targets the source session after that session moves right. Toasts
  are session-scoped, so the shifted index does not matter.
- Description: "Inserts a new lane immediately to the **left of the focused
  lane**…", with the same Notes as New Lane plus "The agent you were in moves
  right and stays focused."
- Keywords: `new lane before`, `insert lane left`, `add lane left`, `left`,
  `prepend`, plus the shared ones.
- Mention "New Lane Before" in the Stage Shape… description list.

### 4. Catalog and discoverability

- `catalog.test.ts`: add `new-tiled-lane-before` to the id list and the
  "Additions so far" comment. The count assertions move by one. (Command PRs
  conflict here; see the #960 memory. Rebase late.)
- `controlReference.ts` grid entry: add the id to `commandIds`.
- `StarterHintCard.tsx`: **leave it unchanged.** The hint card teaches the
  primary path, and two lane-insert hints is noise.
- **No default keybinding.** New Lane has none either. Users can bind it in
  Keyboard Shortcuts. If they want one later, run `check:keybindings`; a green
  run does not mean a chord is free on macOS (keybindings-checker memory).

### 5. Root management / agents

`controlReference` lists the command id, so the `ac_*` catalog picks the
command up the same way it already handles New Lane. No new MCP tool is
needed.

## Decisions (defaults; flag if wrong)

1. **Title "New Lane Before"**, not "New Lane Left". The wording comes from
   the request. It reads well next to the existing New Lane, and
   keywords cover "left".
2. **Existing New Lane keeps its title.** Renaming it "New Lane After" would
   be more symmetric but changes a learned name. It's a one-line change if
   wanted.
3. **Focus stays on the source agent**, not on the new empty lane. This
   matches New Lane.
4. **No default shortcut.**

## Tests

- `gridShapeMutations.test.ts`: port the existing `insertLaneRightIntoGrid`
  cases to `insertLaneIntoGrid(..., 'after')` and add `'before'` cases:
  - Insert before lane 0 of row 0: the new lane is at index 0 and focus 0→1.
  - Insert before the first lane of row 1 (`[2,2]`, laneIndex 2): row 1 gets
    longer, row 0 does not, and the new lane is at global index 2.
  - Insert before a lane to the right of focus: focus does not change.
  - Weights: the new weight is the target row's average, spliced at
    `laneIndex`.
  - The caps and bad-index refusals return null (same table as `'after'`).
- `layoutCommands.renderer.test.ts`: the harness mocks `insertTiledLane`. Add
  New Lane Before cases matching the existing New Lane ones: it calls
  `(focusedLane, 'before')`, toasts the source session, and stays inert when
  `when` is false or the insert is refused.
- `laneSelectionWake.renderer.test.tsx`: update to the renamed helper.

Gate: `npx tsc -b` and the touched vitest files, run once at the end.

## Out of scope

- A "New Row Above" counterpart to `new-dispatch-row` (below only). It has
  the same shape of gap but is a separate request.
- Lane context-menu or header affordances. This change is palette-only.
