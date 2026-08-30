import { describe, expect, it } from 'vitest'

import {
  normalizeGridShape,
  rowIndexForLane,
  rowStartIndex,
} from '@renderer/workspace/dispatch/gridShape'
import type {
  DispatchGridRow,
  SessionId,
  TiledDispatchState,
} from '@renderer/workspace/types'

// Lanes are identified by their session id in these assertions because the flat
// row-major array is the thing every coherence helper walks (see
// tiledDispatchSelectors' header). Asserting on ids rather than lane objects
// makes a mis-sliced row visible as reordered agents, which is how the bug
// would actually present.
function tiled(
  ids: Array<string | undefined>,
  focusedLane: number,
  extra: Partial<TiledDispatchState> = {},
): TiledDispatchState {
  return {
    lanes: ids.map(id => (id ? { selectedSessionId: id as SessionId } : {})),
    focusedLane,
    ...extra,
  }
}

const idsOf = (lanes: TiledDispatchState['lanes']): Array<string | undefined> =>
  lanes.map(lane => lane.selectedSessionId)

const lengths = (rows: DispatchGridRow[]): number[] => rows.map(row => row.length)

describe('normalizeGridShape', () => {
  it('treats state written before the grid existed as a single row', () => {
    // The whole backward-compatibility story. Every workspace.json ever written
    // by Tiled Dispatch has no `rows`, and none of them may need a migration
    // step — absent row shape MEANS one row holding every lane.
    const normalized = normalizeGridShape(tiled(['a', 'b', 'c'], 1))

    expect(lengths(normalized.rows)).toEqual([3])
    expect(idsOf(normalized.lanes)).toEqual(['a', 'b', 'c'])
    expect(normalized.focusedLane).toBe(1)
  })

  it('migrates a legacy ratios array into the row index fraction and lane weights', () => {
    // Legacy `ratios` packs two different things into one array: index 0 is the
    // sidebar fraction, 1..N are lane weights. The grid gives each ROW its own
    // index fraction, so the two halves have to separate. Reading the legacy
    // array as if it were uniform lane weights would silently treat the sidebar
    // fraction as lane 0's width.
    const normalized = normalizeGridShape(
      tiled(['a', 'b', 'c'], 0, { ratios: [0.25, 1, 6, 2] }),
    )

    expect(normalized.rows[0]?.indexFraction).toBe(0.25)
    expect(normalized.laneWeights).toEqual([1, 6, 2])
  })

  it('prefers explicit laneWeights over a stale legacy ratios array', () => {
    // Once a grid has been written in the new format, `ratios` should be gone.
    // If both survive — a partially written file, or a downgrade/upgrade cycle —
    // the new field is the one the user's last drag actually produced.
    const normalized = normalizeGridShape(
      tiled(['a', 'b'], 0, { ratios: [0.9, 99, 99], laneWeights: [1, 3] }),
    )

    expect(normalized.laneWeights).toEqual([1, 3])
  })

  it('grows the last row when the row lengths undercount the lanes', () => {
    // sum(rows[].length) === lanes.length is THE invariant. A violated one
    // cannot throw: this runs on rehydrate, and a hand-edited or half-written
    // workspace.json must degrade into a usable layout rather than take the
    // renderer down with it.
    const normalized = normalizeGridShape(
      tiled(['a', 'b', 'c', 'd', 'e'], 0, { rows: [{ length: 2 }, { length: 1 }] }),
    )

    expect(lengths(normalized.rows)).toEqual([2, 3])
    expect(idsOf(normalized.lanes)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('shrinks the last row when the row lengths overcount the lanes', () => {
    const normalized = normalizeGridShape(
      tiled(['a', 'b', 'c'], 0, { rows: [{ length: 2 }, { length: 4 }] }),
    )

    expect(lengths(normalized.rows)).toEqual([2, 1])
  })

  it('drops trailing rows the lane count cannot support, keeping at least one', () => {
    // Overcounting badly enough that the repair would leave a zero- or
    // negative-length row: those rows have nothing to render, and a row with no
    // lanes is not a row. One row must always survive because the grid's floor
    // is one row (emptying the layout is Dispatch Mode's job, not shape repair).
    const normalized = normalizeGridShape(
      tiled(['a'], 0, { rows: [{ length: 5 }, { length: 5 }, { length: 5 }] }),
    )

    expect(lengths(normalized.rows)).toEqual([1])
  })

  it('keeps one row even when there are no lanes at all', () => {
    const normalized = normalizeGridShape(tiled([], 0))

    expect(normalized.rows).toHaveLength(1)
    expect(normalized.rows[0]?.length).toBe(0)
  })

  it('preserves row metadata while repairing lengths', () => {
    // Repair is about the length invariant. A project binding or a collapsed
    // child cap is the user's decision and must survive a shape repair, or a
    // corrupt length would silently unbind their rows.
    const normalized = normalizeGridShape(
      tiled(['a', 'b', 'c'], 0, {
        rows: [
          { length: 1, projectTabIds: ['tab-1'], capChildren: false },
          { length: 9, height: 2, indexFraction: 0.3 },
        ],
      }),
    )

    expect(lengths(normalized.rows)).toEqual([1, 2])
    expect(normalized.rows[0]?.projectTabIds).toEqual(['tab-1'])
    expect(normalized.rows[0]?.capChildren).toBe(false)
    expect(normalized.rows[1]?.height).toBe(2)
    expect(normalized.rows[1]?.indexFraction).toBe(0.3)
  })

  it('clamps a focused lane that points past the end', () => {
    const normalized = normalizeGridShape(tiled(['a', 'b'], 7))

    expect(normalized.focusedLane).toBe(1)
  })

  it('clamps a negative or non-integer focused lane to the first lane', () => {
    expect(normalizeGridShape(tiled(['a', 'b'], -3)).focusedLane).toBe(0)
    expect(normalizeGridShape(tiled(['a', 'b'], 1.5)).focusedLane).toBe(0)
  })

  it('drops lane weights that do not describe every lane', () => {
    // Partial weights cannot be normalized honestly — there is no defensible
    // width for the lanes they omit. Falling back to an even split is the same
    // degradation the current layout already applies to malformed ratios.
    const normalized = normalizeGridShape(
      tiled(['a', 'b', 'c'], 0, { laneWeights: [1, 2] }),
    )

    expect(normalized.laneWeights).toBeUndefined()
  })

  it('drops lane weights containing a non-positive or non-finite entry', () => {
    expect(
      normalizeGridShape(tiled(['a', 'b'], 0, { laneWeights: [1, 0] })).laneWeights,
    ).toBeUndefined()
    expect(
      normalizeGridShape(tiled(['a', 'b'], 0, { laneWeights: [1, NaN] })).laneWeights,
    ).toBeUndefined()
  })

  it('does not mutate the state it normalizes', () => {
    const current = tiled(['a', 'b', 'c'], 9, { rows: [{ length: 1 }] })
    normalizeGridShape(current)

    expect(current.focusedLane).toBe(9)
    expect(current.rows).toEqual([{ length: 1 }])
  })
})

describe('rowStartIndex', () => {
  it('returns the flat index of each row s first lane', () => {
    const rows: DispatchGridRow[] = [{ length: 3 }, { length: 2 }, { length: 4 }]

    expect(rowStartIndex(rows, 0)).toBe(0)
    expect(rowStartIndex(rows, 1)).toBe(3)
    expect(rowStartIndex(rows, 2)).toBe(5)
  })

  it('returns the total lane count for the index one past the last row', () => {
    // The append position. Row insertion needs it to splice after the final
    // row, so it is a defined coordinate rather than out of range.
    expect(rowStartIndex([{ length: 3 }, { length: 2 }], 2)).toBe(5)
  })
})

describe('rowIndexForLane', () => {
  it('maps a flat lane index back to the row that owns it', () => {
    // The inverse that every command needs: New Lane, Remove Lane, and the
    // row-scoped project filter all start from `focusedLane` and must find its
    // row. An off-by-one here puts a new lane in the wrong row.
    const rows: DispatchGridRow[] = [{ length: 3 }, { length: 2 }]

    expect(rowIndexForLane(rows, 0)).toBe(0)
    expect(rowIndexForLane(rows, 2)).toBe(0)
    expect(rowIndexForLane(rows, 3)).toBe(1)
    expect(rowIndexForLane(rows, 4)).toBe(1)
  })

  it('reports -1 for a lane index no row contains', () => {
    const rows: DispatchGridRow[] = [{ length: 2 }]

    expect(rowIndexForLane(rows, 2)).toBe(-1)
    expect(rowIndexForLane(rows, -1)).toBe(-1)
    expect(rowIndexForLane(rows, 0.5)).toBe(-1)
  })

  it('skips over a zero-length row instead of claiming its neighbour s lane', () => {
    // normalizeGridShape removes empty rows, but this helper is public and its
    // contract should not depend on having been called on normalized input.
    const rows: DispatchGridRow[] = [{ length: 0 }, { length: 2 }]

    expect(rowIndexForLane(rows, 0)).toBe(1)
  })
})
