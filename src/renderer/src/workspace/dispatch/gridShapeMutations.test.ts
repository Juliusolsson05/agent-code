import { describe, expect, it } from 'vitest'

import {
  insertLaneRightIntoGrid,
  insertRowBelowInGrid,
  MAX_DISPATCH_LANES,
  MAX_DISPATCH_ROWS,
  removeLaneFromGrid,
  removeRowFromGrid,
  setGridShape,
} from '@renderer/workspace/dispatch/gridShape'
import { MAX_DISPATCH_TILES } from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import type {
  DispatchGridRow,
  SessionId,
  TiledDispatchState,
} from '@renderer/workspace/types'

function grid(
  ids: Array<string | undefined>,
  rowLengths: number[],
  focusedLane: number,
  extra: Partial<TiledDispatchState> = {},
): TiledDispatchState {
  return {
    lanes: ids.map(id => (id ? { selectedSessionId: id as SessionId } : {})),
    rows: rowLengths.map(length => ({ length })),
    focusedLane,
    ...extra,
  }
}

const idsOf = (state: TiledDispatchState | null): Array<string | undefined> =>
  (state?.lanes ?? []).map(lane => lane.selectedSessionId)

const lengths = (state: TiledDispatchState | null): number[] =>
  (state?.rows ?? []).map((row: DispatchGridRow) => row.length)

describe('insertLaneRightIntoGrid', () => {
  it('lengthens only the row that owns the lane', () => {
    // The ragged-shape contract. Row lengths are independent: asking for space
    // beside one agent must not widen a row the user was not editing. A shared
    // column count would make this add a lane to BOTH rows, which is the most
    // surprising possible outcome — a slot appears where you were not looking.
    const next = insertLaneRightIntoGrid(grid(['a', 'b', 'c', 'd'], [2, 2], 0), 0)

    expect(lengths(next)).toEqual([3, 2])
    expect(idsOf(next)).toEqual(['a', undefined, 'b', 'c', 'd'])
  })

  it('inserts an empty lane, never an auto-filled one', () => {
    // A new slot is a request for SPACE, not for a particular agent (#673).
    // Auto-filling claims the first unclaimed visible row, which in the common
    // case duplicates the top of the index into the slot beside you.
    const next = insertLaneRightIntoGrid(grid(['a', 'b'], [2], 1), 1)

    expect(idsOf(next)).toEqual(['a', 'b', undefined])
  })

  it('keeps the focused lane on its own agent when inserting after it', () => {
    const next = insertLaneRightIntoGrid(grid(['a', 'b', 'c'], [3], 1), 1)

    expect(next?.focusedLane).toBe(1)
    expect(next?.lanes[next.focusedLane]?.selectedSessionId).toBe('b')
  })

  it('follows the focused session when a caller inserts before it', () => {
    // This helper is public and accepts any coordinate. Preserving only the
    // numeric index would silently retarget every keyboard command from c to b.
    const next = insertLaneRightIntoGrid(grid(['a', 'b', 'c'], [3], 2), 0)

    expect(next?.focusedLane).toBe(3)
    expect(next?.lanes[next.focusedLane]?.selectedSessionId).toBe('c')
  })

  it('follows the focused session when inserting into an earlier row', () => {
    // The two-dimensional version of the case above: an insertion in row 0
    // shifts every lane in row 1 one place right in the flat array.
    const next = insertLaneRightIntoGrid(grid(['a', 'b', 'c', 'd'], [2, 2], 3), 0)

    expect(next?.focusedLane).toBe(4)
    expect(next?.lanes[next.focusedLane]?.selectedSessionId).toBe('d')
  })

  it('gives the newcomer its own row s average weight', () => {
    // Weights are scale-free, so the row average is exactly one equal share of
    // the enlarged row while every existing lane keeps its proportion. The
    // average must come from the TARGET row: borrowing a wide neighbouring
    // row's average would size the new lane against a row it is not in.
    const next = insertLaneRightIntoGrid(
      grid(['a', 'b', 'c', 'd'], [2, 2], 0, { laneWeights: [1, 3, 10, 10] }),
      0,
    )

    expect(next?.laneWeights).toEqual([1, 2, 3, 10, 10])
  })

  it('leaves implicit even sizing implicit', () => {
    const next = insertLaneRightIntoGrid(grid(['a', 'b'], [2], 0), 0)

    expect(next?.laneWeights).toBeUndefined()
  })

  it('refuses at the per-row column cap without consulting other rows', () => {
    const full = Array.from({ length: MAX_DISPATCH_TILES }, (_, i) => `a${i}`)
    const state = grid([...full, 'b'], [MAX_DISPATCH_TILES, 1], 0)

    expect(insertLaneRightIntoGrid(state, 0)).toBeNull()
    // The second row is nowhere near the cap, so it must still accept a lane.
    expect(lengths(insertLaneRightIntoGrid(state, MAX_DISPATCH_TILES)))
      .toEqual([MAX_DISPATCH_TILES, 2])
  })

  it('refuses at the total lane ceiling even when the row has room', () => {
    // Two independent caps. The per-row cap protects readability; the total cap
    // protects memory, because every lane mounts a real agent view.
    const ids = Array.from({ length: MAX_DISPATCH_LANES }, (_, i) => `a${i}`)
    const state = grid(ids, [4, 4, 4, 4], 0)

    expect(insertLaneRightIntoGrid(state, 0)).toBeNull()
  })

  it('refuses an index no row owns', () => {
    expect(insertLaneRightIntoGrid(grid(['a', 'b'], [2], 0), 2)).toBeNull()
    expect(insertLaneRightIntoGrid(grid(['a', 'b'], [2], 0), -1)).toBeNull()
    expect(insertLaneRightIntoGrid(grid(['a', 'b'], [2], 0), 0.5)).toBeNull()
  })

  it('does not mutate the state it is given', () => {
    const current = grid(['a', 'b'], [2], 0)
    insertLaneRightIntoGrid(current, 0)

    expect(idsOf(current)).toEqual(['a', 'b'])
    expect(lengths(current)).toEqual([2])
  })
})

describe('removeLaneFromGrid', () => {
  it('shortens only the row that owns the lane', () => {
    const next = removeLaneFromGrid(grid(['a', 'b', 'c', 'd'], [3, 1], 0), 1)

    expect(lengths(next)).toEqual([2, 1])
    expect(idsOf(next)).toEqual(['a', 'c', 'd'])
  })

  it('removes the row when its last lane goes', () => {
    // A row with no lanes is not a row — it would render as an index list
    // beside nothing. Collapsing is the only coherent outcome.
    const next = removeLaneFromGrid(grid(['a', 'b', 'c'], [2, 1], 0), 2)

    expect(lengths(next)).toEqual([2])
    expect(idsOf(next)).toEqual(['a', 'b'])
  })

  it('refuses to remove the last lane of the last row', () => {
    // Emptying the layout is Dispatch Mode's job. A lane removal that silently
    // became a mode exit would be two different actions sharing one name.
    expect(removeLaneFromGrid(grid(['a'], [1], 0), 0)).toBeNull()
  })

  it('shifts focus down when an earlier lane is removed', () => {
    const next = removeLaneFromGrid(grid(['a', 'b', 'c'], [3], 2), 0)

    expect(next?.focusedLane).toBe(1)
    expect(next?.lanes[next.focusedLane]?.selectedSessionId).toBe('c')
  })

  it('clamps focus that pointed at the removed tail lane', () => {
    const next = removeLaneFromGrid(grid(['a', 'b'], [2], 1), 1)

    expect(next?.focusedLane).toBe(0)
  })

  it('drops the removed lane s weight and keeps the rest', () => {
    const next = removeLaneFromGrid(
      grid(['a', 'b', 'c'], [3], 0, { laneWeights: [1, 5, 9] }),
      1,
    )

    expect(next?.laneWeights).toEqual([1, 9])
  })

  it('refuses an index no row owns', () => {
    expect(removeLaneFromGrid(grid(['a', 'b'], [2], 0), 5)).toBeNull()
    expect(removeLaneFromGrid(grid(['a', 'b'], [2], 0), -1)).toBeNull()
  })
})

describe('insertRowBelowInGrid', () => {
  it('inherits the source row s length rather than any global column count', () => {
    // P3: there is no global column count. New Row below a 4-lane row makes a
    // 4-lane row; below a 2-lane row, a 2-lane row. Reading a shared width here
    // would be the first place a rectangle could sneak back in.
    const wide = insertRowBelowInGrid(grid(['a', 'b', 'c', 'd', 'e'], [4, 1], 0), 0)
    const narrow = insertRowBelowInGrid(grid(['a', 'b', 'c', 'd', 'e'], [4, 1], 0), 1)

    expect(lengths(wide)).toEqual([4, 4, 1])
    expect(lengths(narrow)).toEqual([4, 1, 1])
  })

  it('arrives empty', () => {
    const next = insertRowBelowInGrid(grid(['a', 'b'], [2], 0), 0)

    expect(idsOf(next)).toEqual(['a', 'b', undefined, undefined])
  })

  it('leaves focus on the source row', () => {
    // New Row mirrors New Lane's contract: it asks for space, so it must not
    // move the user away from the agent they were commanding.
    const next = insertRowBelowInGrid(grid(['a', 'b'], [2], 1), 0)

    expect(next?.focusedLane).toBe(1)
    expect(next?.lanes[next.focusedLane]?.selectedSessionId).toBe('b')
  })

  it('follows the focused session when a caller inserts above it', () => {
    const next = insertRowBelowInGrid(grid(['a', 'b', 'c'], [1, 2], 2), 0)

    expect(next?.focusedLane).toBe(3)
    expect(next?.lanes[next.focusedLane]?.selectedSessionId).toBe('c')
  })

  it('truncates the new row to the remaining total capacity', () => {
    // Preferring a shorter row over a refusal: the user asked for a row, and
    // giving them a narrower one is closer to their intent than nothing.
    const ids = Array.from({ length: MAX_DISPATCH_LANES - 2 }, (_, i) => `a${i}`)
    const next = insertRowBelowInGrid(grid(ids, [7, 7], 0), 0)

    expect(lengths(next)).toEqual([7, 2, 7])
    expect(next?.lanes).toHaveLength(MAX_DISPATCH_LANES)
  })

  it('does not make the new empty row the tallest row on screen', () => {
    // Heights are scale-free but NOT written on a common scale: the drag
    // handler persists fractions summing to 1, while an un-sized row defaults
    // to 1. A defaulted new row beside dragged siblings of 0.7/0.3 rendered as
    // the tallest thing on screen — an empty row dominating two working ones.
    const next = insertRowBelowInGrid(
      {
        lanes: [{}, {}],
        rows: [{ length: 1, height: 0.7 }, { length: 1, height: 0.3 }],
        focusedLane: 0,
      },
      0,
    )

    expect(next?.rows?.[1]?.height).toBeCloseTo(0.5)
    // And it sits between them rather than dwarfing either.
    const heights = next!.rows!.map(row => row.height!)
    expect(Math.max(...heights)).toBe(0.7)
  })

  it('leaves heights implicit when no row has been sized', () => {
    // An even grid must stay even: inventing a height for one row would make
    // every other row's implicit default mean something different.
    const next = insertRowBelowInGrid(
      { lanes: [{}, {}], rows: [{ length: 1 }, { length: 1 }], focusedLane: 0 },
      0,
    )

    expect(next?.rows?.every(row => row.height === undefined)).toBe(true)
  })

  it('refuses at the row cap', () => {
    const state = grid(['a', 'b', 'c', 'd'], [1, 1, 1, 1], 0)

    expect(state.rows).toHaveLength(MAX_DISPATCH_ROWS)
    expect(insertRowBelowInGrid(state, 0)).toBeNull()
  })

  it('refuses when no lane capacity remains', () => {
    const ids = Array.from({ length: MAX_DISPATCH_LANES }, (_, i) => `a${i}`)

    expect(insertRowBelowInGrid(grid(ids, [8, 8], 0), 0)).toBeNull()
  })
})

describe('removeRowFromGrid', () => {
  it('removes exactly that row s lanes', () => {
    const next = removeRowFromGrid(grid(['a', 'b', 'c', 'd'], [1, 2, 1], 0), 1)

    expect(lengths(next)).toEqual([1, 1])
    expect(idsOf(next)).toEqual(['a', 'd'])
  })

  it('refuses to remove the only row', () => {
    expect(removeRowFromGrid(grid(['a', 'b'], [2], 0), 0)).toBeNull()
  })

  it('moves focus to the start of the surviving row when the focused row goes', () => {
    // Focus must land somewhere visible. The removed row's ordinal position is
    // the closest surviving thing to where the user was looking.
    const next = removeRowFromGrid(grid(['a', 'b', 'c', 'd'], [2, 2], 3), 1)

    expect(next?.focusedLane).toBe(0)
    expect(next?.lanes[next.focusedLane]?.selectedSessionId).toBe('a')
  })

  it('shifts focus down when an earlier row goes', () => {
    const next = removeRowFromGrid(grid(['a', 'b', 'c'], [2, 1], 2), 0)

    expect(next?.focusedLane).toBe(0)
    expect(next?.lanes[next.focusedLane]?.selectedSessionId).toBe('c')
  })

  it('drops the removed row s weights', () => {
    const next = removeRowFromGrid(
      grid(['a', 'b', 'c'], [1, 2], 0, { laneWeights: [1, 5, 9] }),
      1,
    )

    expect(next?.laneWeights).toEqual([1])
  })

  it('refuses a row index that does not exist', () => {
    expect(removeRowFromGrid(grid(['a', 'b'], [1, 1], 0), 2)).toBeNull()
    expect(removeRowFromGrid(grid(['a', 'b'], [1, 1], 0), -1)).toBeNull()
  })
})

/** Positional reshape: every output row keeps the identity of the row at the
 *  same index. Matches what the editor sends when no row was added or removed. */
const positional = (...lengths: number[]) =>
  lengths.map((length, index) => ({ length, sourceRow: index }))

describe('setGridShape', () => {
  it('keeps each row s surviving agents in place while growing', () => {
    const next = setGridShape(grid(['a', 'b', 'c'], [2, 1], 0), positional(3, 2))

    expect(lengths(next)).toEqual([3, 2])
    expect(idsOf(next)).toEqual(['a', 'b', undefined, 'c', undefined])
  })

  it('drops from the tail of each row while shrinking', () => {
    const next = setGridShape(grid(['a', 'b', 'c', 'd'], [3, 1], 0), positional(1, 1))

    expect(idsOf(next)).toEqual(['a', 'd'])
  })

  it('accepts a ragged shape', () => {
    // The shape editor's whole reason for existing. Four on top and two below
    // must be expressible in one commit, not approximated by a rectangle.
    const next = setGridShape(grid(['a'], [1], 0), [{ length: 4, sourceRow: 0 }, { length: 2, sourceRow: null }])

    expect(lengths(next)).toEqual([4, 2])
    expect(next?.lanes).toHaveLength(6)
  })

  it('preserves row metadata by position', () => {
    // A row's project binding and density are the user's decisions. Resizing
    // the grid is a statement about SPACE and must not silently unbind a row.
    const next = setGridShape(
      grid(['a', 'b'], [1, 1], 0, {
        rows: [
          { length: 1, projectTabIds: ['tab-9'], capChildren: false },
          { length: 1, height: 3 },
        ],
      }),
      positional(2, 2),
    )

    expect(next?.rows?.[0]?.projectTabIds).toEqual(['tab-9'])
    expect(next?.rows?.[0]?.capChildren).toBe(false)
    expect(next?.rows?.[1]?.height).toBe(3)
  })

  it('adds and removes rows to match the requested shape', () => {
    expect(lengths(setGridShape(grid(['a'], [1], 0), [{ length: 1, sourceRow: 0 }, { length: 1, sourceRow: null }, { length: 1, sourceRow: null }]))).toEqual([1, 1, 1])
    expect(lengths(setGridShape(grid(['a', 'b', 'c'], [1, 1, 1], 0), positional(1)))).toEqual([1])
  })

  it('clamps focus into the resulting lanes', () => {
    const next = setGridShape(grid(['a', 'b', 'c'], [3], 2), positional(1))

    expect(next?.focusedLane).toBe(0)
  })

  it('refuses a shape that breaks any cap', () => {
    const state = grid(['a'], [1], 0)

    expect(setGridShape(state, [])).toBeNull()
    expect(setGridShape(state, positional(0))).toBeNull()
    expect(setGridShape(state, positional(1.5))).toBeNull()
    expect(setGridShape(state, positional(MAX_DISPATCH_TILES + 1))).toBeNull()
    expect(setGridShape(state, positional(...Array(MAX_DISPATCH_ROWS + 1).fill(1)))).toBeNull()
    expect(setGridShape(state, positional(MAX_DISPATCH_TILES, MAX_DISPATCH_TILES))).toBeNull()
  })
})

describe('setGridShape row identity', () => {
  // The review finding this exists for: the shape editor used to send a bare
  // number[] of lengths. Removing the middle of three rows shifted every later
  // row up a slot, so a positional apply re-pointed row 1's metadata at row 2's
  // contents — it deleted the LAST row and resized the survivors, evicting
  // agents from rows the user never touched.
  const bound = (length: number, tab: string): DispatchGridRow =>
    ({ length, projectTabIds: [tab] })

  it('removes the row the user removed, not the last one', () => {
    const state: TiledDispatchState = {
      lanes: ['a1', 'a2', 'b1', 'b2', 'c1', 'c2'].map(id => ({ selectedSessionId: id as SessionId })),
      rows: [bound(2, 'tab-A'), bound(2, 'tab-B'), bound(2, 'tab-C')],
      focusedLane: 0,
    }

    // The user removed the MIDDLE row, so rows A and C survive with their own
    // lanes and their own bindings.
    const next = setGridShape(state, [
      { length: 2, sourceRow: 0 },
      { length: 2, sourceRow: 2 },
    ])

    expect(idsOf(next)).toEqual(['a1', 'a2', 'c1', 'c2'])
    expect(next?.rows?.map(row => row.projectTabIds?.[0])).toEqual(['tab-A', 'tab-C'])
  })

  it('does not resize the rows that survive a removal', () => {
    // The ragged version, which was worse: a positional apply shrank the 4-lane
    // row to 1, grew the 1-lane row to 2, and dropped the third row entirely.
    const state: TiledDispatchState = {
      lanes: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(id => ({ selectedSessionId: id as SessionId })),
      rows: [bound(4, 'tab-A'), bound(1, 'tab-B'), bound(2, 'tab-C')],
      focusedLane: 0,
    }

    // Removing the FIRST row leaves B and C at their own widths.
    const next = setGridShape(state, [
      { length: 1, sourceRow: 1 },
      { length: 2, sourceRow: 2 },
    ])

    expect(lengths(next)).toEqual([1, 2])
    expect(idsOf(next)).toEqual(['e', 'f', 'g'])
    expect(next?.rows?.map(row => row.projectTabIds?.[0])).toEqual(['tab-B', 'tab-C'])
  })

  it('gives a genuinely new row empty lanes and no inherited binding', () => {
    const state: TiledDispatchState = {
      lanes: [{ selectedSessionId: 'a' as SessionId }],
      rows: [bound(1, 'tab-A')],
      focusedLane: 0,
    }

    const next = setGridShape(state, [
      { length: 1, sourceRow: 0 },
      { length: 2, sourceRow: null },
    ])

    expect(idsOf(next)).toEqual(['a', undefined, undefined])
    expect(next?.rows?.map(row => row.projectTabIds?.[0])).toEqual(['tab-A', undefined])
  })

  it('follows the focused lane to wherever its row ended up', () => {
    // Clamping the stale flat index instead would move focus into a DIFFERENT
    // row: growing the top row makes the old index a brand-new top-row lane, and
    // the next session command would target a row the user was not working in.
    const state: TiledDispatchState = {
      lanes: ['a1', 'a2', 'b1', 'b2'].map(id => ({ selectedSessionId: id as SessionId })),
      rows: [{ length: 2 }, { length: 2 }],
      focusedLane: 3,
    }

    const next = setGridShape(state, [
      { length: 4, sourceRow: 0 },
      { length: 2, sourceRow: 1 },
    ])

    expect(next?.lanes[next.focusedLane]?.selectedSessionId).toBe('b2')
  })

  it('keeps focus in its own row when that row shrinks under it', () => {
    const state: TiledDispatchState = {
      lanes: ['a1', 'b1', 'b2', 'b3'].map(id => ({ selectedSessionId: id as SessionId })),
      rows: [{ length: 1 }, { length: 3 }],
      focusedLane: 3,
    }

    const next = setGridShape(state, [
      { length: 1, sourceRow: 0 },
      { length: 2, sourceRow: 1 },
    ])

    // Column 2 no longer exists in that row, so focus clamps to its last lane —
    // still inside the row the user was working in.
    expect(next?.focusedLane).toBe(2)
    expect(next?.lanes[next.focusedLane]?.selectedSessionId).toBe('b2')
  })
})
