import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  normalizeDispatchModeGrid,
  scrubGridRowMetadata,
} from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import type { DispatchModeState, SessionId, WorkspaceState } from '@renderer/workspace/types'

// Restoring a workspace written before Grid Dispatch existed.
//
// The fixture is a REAL persisted Agent Code workspace, and the thing that
// makes it worth using here rather than a hand-built state is its `tiled` block:
// it carries a genuine legacy `ratios` array produced by the single-row layout,
// with the index fraction the user actually dragged. Every claim about the
// migration is checked against that, not against a plausible-looking literal.
const FIXTURE = JSON.parse(
  readFileSync('testing/fixtures/worktree-context/dispatch-global-d23.json', 'utf8'),
) as { state: WorkspaceState }

const RECORDED = FIXTURE.state.dispatchMode!

describe('restoring a pre-grid workspace', () => {
  it('is a workspace with the legacy shape, or these assertions prove nothing', () => {
    // Guard on the fixture itself. If it is ever re-recorded from a build that
    // already writes `rows`, the migration below stops being exercised and
    // every test in this file would keep passing while covering nothing.
    expect(RECORDED.tiled?.ratios).toBeDefined()
    expect(RECORDED.tiled?.rows).toBeUndefined()
    expect(RECORDED.tiled?.laneWeights).toBeUndefined()
  })

  it('restores as a single row holding every recorded lane', () => {
    const normalized = normalizeDispatchModeGrid(RECORDED)
    const tiled = normalized!.tiled!

    expect(tiled.rows).toHaveLength(1)
    expect(tiled.rows![0]!.length).toBe(RECORDED.tiled!.lanes.length)
    expect(tiled.lanes).toEqual(RECORDED.tiled!.lanes)
    expect(tiled.focusedLane).toBe(RECORDED.tiled!.focusedLane)
  })

  it('keeps the index width the user actually dragged', () => {
    // The half of `ratios` that is NOT a lane weight. Losing it would snap the
    // sidebar back to its default on the first launch after upgrading — a width
    // the user deliberately set, silently discarded by a migration.
    const normalized = normalizeDispatchModeGrid(RECORDED)

    expect(normalized!.tiled!.rows![0]!.indexFraction).toBe(RECORDED.tiled!.ratios![0])
  })

  it('carries the recorded lane weights across, one per lane', () => {
    const normalized = normalizeDispatchModeGrid(RECORDED)

    expect(normalized!.tiled!.laneWeights).toEqual(RECORDED.tiled!.ratios!.slice(1))
    expect(normalized!.tiled!.laneWeights).toHaveLength(RECORDED.tiled!.lanes.length)
  })

  it('stops writing the legacy array once it has been split', () => {
    // Leaving both formats behind would mean two sources of truth for width,
    // and the next reader would have to guess which one the last drag wrote.
    const normalized = normalizeDispatchModeGrid(RECORDED)

    expect(normalized!.tiled!.ratios).toBeUndefined()
  })

  it('leaves classic Dispatch and grid-less state alone', () => {
    // Same defensive shape as every other helper in this family: a stray call
    // against non-tiled state must be a no-op, not a crash or a spurious grid.
    const classic: DispatchModeState = { scope: 'project', focusedSessionId: 'a1' }

    expect(normalizeDispatchModeGrid(classic)).toBe(classic)
    expect(normalizeDispatchModeGrid(null)).toBeNull()
  })

  it('returns the same reference when a grid is already normalized', () => {
    // Rehydrate is not the only caller this could acquire, and a helper that
    // mints a new object on every call would churn every consumer that memoizes
    // on dispatchMode identity.
    const already = normalizeDispatchModeGrid(RECORDED)!

    expect(normalizeDispatchModeGrid(already)).toBe(already)
  })
})

describe('scrubbing row metadata at the autosave boundary', () => {
  // Row metadata names two things that can disappear: a project tab and a set
  // of expanded parent sessions. Both must be scrubbed where every other
  // durable pointer is, or workspace.json keeps a binding to a closed project —
  // which filters that row's index to nothing, permanently, with no UI path
  // back because the picker only lists tabs that exist.
  const gridMode = (row: Record<string, unknown>): DispatchModeState => ({
    scope: 'global',
    tiled: { lanes: [{}], rows: [{ length: 1, ...row }], focusedLane: 0 },
  })

  it('drops a binding to a project that no longer exists', () => {
    const scrubbed = scrubGridRowMetadata(
      gridMode({ projectTabIds: ['tab-gone'] }),
      new Set(['tab-live']),
      new Set<SessionId>(),
    )

    expect(scrubbed!.tiled!.rows![0]!.projectTabIds).toBeUndefined()
  })

  it('keeps a binding to a project that survives', () => {
    const scrubbed = scrubGridRowMetadata(
      gridMode({ projectTabIds: ['tab-live'] }),
      new Set(['tab-live']),
      new Set<SessionId>(),
    )

    expect(scrubbed!.tiled!.rows![0]!.projectTabIds).toEqual(['tab-live'])
  })

  it('drops expanded parents whose sessions are gone, keeping the rest', () => {
    const scrubbed = scrubGridRowMetadata(
      gridMode({ expandedParents: ['dead' as SessionId, 'alive' as SessionId] }),
      new Set(['tab-live']),
      new Set(['alive' as SessionId]),
    )

    expect(scrubbed!.tiled!.rows![0]!.expandedParents).toEqual(['alive'])
  })

  it('drops the field entirely when no expanded parent survives', () => {
    // An empty array and an absent field mean the same thing to the reader, and
    // persisting the empty one is durable noise.
    const scrubbed = scrubGridRowMetadata(
      gridMode({ expandedParents: ['dead' as SessionId] }),
      new Set(['tab-live']),
      new Set<SessionId>(),
    )

    expect(scrubbed!.tiled!.rows![0]!.expandedParents).toBeUndefined()
  })

  it('returns the same reference when nothing needed scrubbing', () => {
    const clean = gridMode({ projectTabIds: ['tab-live'] })

    expect(scrubGridRowMetadata(clean, new Set(['tab-live']), new Set<SessionId>()))
      .toBe(clean)
  })

  it('leaves classic Dispatch alone', () => {
    const classic: DispatchModeState = { scope: 'project' }

    expect(scrubGridRowMetadata(classic, new Set<string>(), new Set<SessionId>()))
      .toBe(classic)
  })
})

describe('ragged shapes survive persistence', () => {
  // P3 as a durability contract. Every other ragged assertion lives in
  // gridShapeMutations against the pure functions; this one exists because the
  // failure mode it guards is different in kind — a normalization that
  // "tidied" 4/2 into 3/3 would look like a layout bug on the next launch, long
  // after the code that did it.
  it('round-trips an uneven grid unchanged', () => {
    const uneven: DispatchModeState = {
      scope: 'global',
      tiled: {
        lanes: Array.from({ length: 6 }, () => ({})),
        rows: [{ length: 4 }, { length: 2 }],
        focusedLane: 5,
      },
    }

    const restored = normalizeDispatchModeGrid(uneven)

    expect(restored!.tiled!.rows!.map(row => row.length)).toEqual([4, 2])
    expect(restored!.tiled!.focusedLane).toBe(5)
    // Same reference: a coherent shape must not be rebuilt, or every consumer
    // memoizing on dispatchMode identity churns on every restore.
    expect(restored).toBe(uneven)
  })

  it('does not redistribute lanes toward a rectangle when repairing', () => {
    // A repair caused by a corrupt LENGTH must still not even out the rows it
    // leaves behind: the surplus goes to the last row, so row 0 keeps the width
    // the user chose.
    const corrupt: DispatchModeState = {
      scope: 'global',
      tiled: {
        lanes: Array.from({ length: 6 }, () => ({})),
        rows: [{ length: 4 }, { length: 1 }],
        focusedLane: 0,
      },
    }

    const restored = normalizeDispatchModeGrid(corrupt)

    expect(restored!.tiled!.rows!.map(row => row.length)).toEqual([4, 2])
  })
})

describe('row project bindings become a set', () => {
  // "Any project" must have exactly ONE representation. With `undefined`, `[]`,
  // and a stale single `projectTabId` all reachable, every reader would need to
  // test for three things and one would eventually forget.
  const rowMode = (row: Record<string, unknown>): DispatchModeState => ({
    scope: 'global',
    tiled: { lanes: [{}], rows: [{ length: 1, ...row }], focusedLane: 0 },
  })
  const rowOf = (mode: DispatchModeState | null | undefined) => mode!.tiled!.rows![0]!

  it('folds a legacy single binding into the set and stops writing the old field', () => {
    const restored = normalizeDispatchModeGrid(rowMode({ projectTabId: 'tab-a' }))

    expect(rowOf(restored).projectTabIds).toEqual(['tab-a'])
    expect(rowOf(restored).projectTabId).toBeUndefined()
  })

  it('prefers an explicit set over a stale legacy field', () => {
    // Both surviving means a partial write or an upgrade/downgrade cycle; the
    // plural field is the one the user's last edit produced.
    const restored = normalizeDispatchModeGrid(
      rowMode({ projectTabId: 'tab-stale', projectTabIds: ['tab-a', 'tab-b'] }),
    )

    expect(rowOf(restored).projectTabIds).toEqual(['tab-a', 'tab-b'])
    expect(rowOf(restored).projectTabId).toBeUndefined()
  })

  it('collapses an empty set to absent', () => {
    const restored = normalizeDispatchModeGrid(rowMode({ projectTabIds: [] }))

    expect(rowOf(restored).projectTabIds).toBeUndefined()
  })

  it('leaves an UNBOUND row untouched by reference', () => {
    // The common case, and the one that would break everything quietly: if
    // normalization rebuilt plain rows, the lane-selection race check — which
    // compares row objects across an async wake — would see a different object
    // every time and drop every selection.
    const plain: DispatchModeState = {
      scope: 'global',
      tiled: { lanes: [{}], rows: [{ length: 1 }], focusedLane: 0 },
    }

    expect(normalizeDispatchModeGrid(plain)).toBe(plain)
  })

  it('leaves a healthy multi-project row untouched by reference', () => {
    // Row identity is load-bearing: the lane-selection race check compares row
    // objects across a wake, so a normalization that rebuilt every row would
    // make every selection drop.
    const healthy = rowMode({ projectTabIds: ['tab-a', 'tab-b'] })

    expect(normalizeDispatchModeGrid(healthy)).toBe(healthy)
  })

  it('scrubs dead bindings and unbinds a row that loses all of them', () => {
    const partial = scrubGridRowMetadata(
      rowMode({ projectTabIds: ['tab-live', 'tab-gone'] }),
      new Set(['tab-live']),
      new Set<SessionId>(),
    )
    expect(rowOf(partial).projectTabIds).toEqual(['tab-live'])

    // All bindings dead: an empty set would filter the index to nothing with no
    // UI path back, since the picker only offers tabs that exist.
    const total = scrubGridRowMetadata(
      rowMode({ projectTabIds: ['tab-gone', 'tab-also-gone'] }),
      new Set(['tab-live']),
      new Set<SessionId>(),
    )
    expect(rowOf(total).projectTabIds).toBeUndefined()
  })
})
