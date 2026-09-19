import { describe, expect, it } from 'vitest'

import {
  normalizeStage,
  scrubGridRowMetadata,
} from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import { loadRecordedDispatchWorkspace } from '@renderer/workspace/testing/recordedDispatchWorkspace'
import type { SessionId, TiledDispatchState } from '@renderer/workspace/types'

// Restoring a workspace written before Grid Dispatch existed.
//
// The fixture is a REAL persisted Agent Code workspace, and the thing that
// makes it worth using here rather than a hand-built state is its `tiled` block:
// it carries a genuine legacy `ratios` array produced by the single-row layout,
// with the index fraction the user actually dragged. Every claim about the
// migration is checked against that, not against a plausible-looking literal.
//
// RECORDED is the recorded `tiled` block VERBATIM — the shared loader moves it
// to `state.stage` without normalizing, precisely so this suite still gets the
// legacy array. These helpers took the whole `dispatchMode` envelope until
// #992 made the stage a required field; their subject was always the lane
// grid inside it, which is what they take now.
const RECORDED = loadRecordedDispatchWorkspace().state.stage

describe('restoring a pre-grid workspace', () => {
  it('is a workspace with the legacy shape, or these assertions prove nothing', () => {
    // Guard on the fixture itself. If it is ever re-recorded from a build that
    // already writes `rows`, the migration below stops being exercised and
    // every test in this file would keep passing while covering nothing.
    expect(RECORDED.ratios).toBeDefined()
    expect(RECORDED.rows).toBeUndefined()
    expect(RECORDED.laneWeights).toBeUndefined()
  })

  it('restores as a single row holding every recorded lane', () => {
    const normalized = normalizeStage(RECORDED)
    const tiled = normalized

    expect(tiled.rows).toHaveLength(1)
    expect(tiled.rows![0]!.length).toBe(RECORDED.lanes.length)
    expect(tiled.lanes).toEqual(RECORDED.lanes)
    expect(tiled.focusedLane).toBe(RECORDED.focusedLane)
  })

  it('keeps the index width the user actually dragged', () => {
    // The half of `ratios` that is NOT a lane weight. Losing it would snap the
    // sidebar back to its default on the first launch after upgrading — a width
    // the user deliberately set, silently discarded by a migration.
    const normalized = normalizeStage(RECORDED)

    expect(normalized.rows![0]!.indexFraction).toBe(RECORDED.ratios![0])
  })

  it('carries the recorded lane weights across, one per lane', () => {
    const normalized = normalizeStage(RECORDED)

    expect(normalized.laneWeights).toEqual(RECORDED.ratios!.slice(1))
    expect(normalized.laneWeights).toHaveLength(RECORDED.lanes.length)
  })

  it('stops writing the legacy array once it has been split', () => {
    // Leaving both formats behind would mean two sources of truth for width,
    // and the next reader would have to guess which one the last drag wrote.
    const normalized = normalizeStage(RECORDED)

    expect(normalized.ratios).toBeUndefined()
  })

  // "leaves classic Dispatch and grid-less state alone" lived here until #992:
  // it fed the normalizer a lane-less envelope and `null`. Neither input can be
  // expressed any more — the parameter is the grid itself.

  it('returns the same reference when a grid is already normalized', () => {
    // Rehydrate is not the only caller this could acquire, and a helper that
    // mints a new object on every call would churn every consumer that memoizes
    // on stage identity.
    const already = normalizeStage(RECORDED)

    expect(normalizeStage(already)).toBe(already)
  })

describe('scrubbing row metadata at the autosave boundary', () => {
  // Row metadata names two things that can disappear: a project tab and a set
  // of expanded parent sessions. Both must be scrubbed where every other
  // durable pointer is, or workspace.json keeps a binding to a closed project —
  // which filters that row's index to nothing, permanently, with no UI path
  // back because the picker only lists tabs that exist.
  const gridMode = (row: Record<string, unknown>): TiledDispatchState => ({
    lanes: [{}], rows: [{ length: 1, ...row }], focusedLane: 0,
  })

  it('drops a binding to a project that no longer exists', () => {
    const scrubbed = scrubGridRowMetadata(
      gridMode({ projectTabIds: ['tab-gone'] }),
      new Set(['tab-live']),
      new Set<SessionId>(),
    )

    expect(scrubbed.rows![0]!.projectTabIds).toBeUndefined()
  })

  it('keeps a binding to a project that survives', () => {
    const scrubbed = scrubGridRowMetadata(
      gridMode({ projectTabIds: ['tab-live'] }),
      new Set(['tab-live']),
      new Set<SessionId>(),
    )

    expect(scrubbed.rows![0]!.projectTabIds).toEqual(['tab-live'])
  })

  it('drops expanded parents whose sessions are gone, keeping the rest', () => {
    const scrubbed = scrubGridRowMetadata(
      gridMode({ expandedParents: ['dead' as SessionId, 'alive' as SessionId] }),
      new Set(['tab-live']),
      new Set(['alive' as SessionId]),
    )

    expect(scrubbed.rows![0]!.expandedParents).toEqual(['alive'])
  })

  it('drops the field entirely when no expanded parent survives', () => {
    // An empty array and an absent field mean the same thing to the reader, and
    // persisting the empty one is durable noise.
    const scrubbed = scrubGridRowMetadata(
      gridMode({ expandedParents: ['dead' as SessionId] }),
      new Set(['tab-live']),
      new Set<SessionId>(),
    )

    expect(scrubbed.rows![0]!.expandedParents).toBeUndefined()
  })

  it('returns the same reference when nothing needed scrubbing', () => {
    const clean = gridMode({ projectTabIds: ['tab-live'] })

    expect(scrubGridRowMetadata(clean, new Set(['tab-live']), new Set<SessionId>()))
      .toBe(clean)
  })

  // ("leaves classic Dispatch alone" lived here until #992, for the same
  // reason as its twin above: there is no lane-less input left to pass.)
})
})

describe('ragged shapes survive persistence', () => {
  // P3 as a durability contract. Every other ragged assertion lives in
  // gridShapeMutations against the pure functions; this one exists because the
  // failure mode it guards is different in kind — a normalization that
  // "tidied" 4/2 into 3/3 would look like a layout bug on the next launch, long
  // after the code that did it.
  it('round-trips an uneven grid unchanged', () => {
    const uneven: TiledDispatchState = {
      lanes: Array.from({ length: 6 }, () => ({})),
      rows: [{ length: 4 }, { length: 2 }],
      focusedLane: 5,
    }

    const restored = normalizeStage(uneven)

    expect(restored.rows!.map(row => row.length)).toEqual([4, 2])
    expect(restored.focusedLane).toBe(5)
    // Same reference: a coherent shape must not be rebuilt, or every consumer
    // memoizing on stage identity churns on every restore.
    expect(restored).toBe(uneven)
  })

  it('does not redistribute lanes toward a rectangle when repairing', () => {
    // A repair caused by a corrupt LENGTH must still not even out the rows it
    // leaves behind: the surplus goes to the last row, so row 0 keeps the width
    // the user chose.
    const corrupt: TiledDispatchState = {
      lanes: Array.from({ length: 6 }, () => ({})),
      rows: [{ length: 4 }, { length: 1 }],
      focusedLane: 0,
    }

    const restored = normalizeStage(corrupt)

    expect(restored.rows!.map(row => row.length)).toEqual([4, 2])
  })
})

describe('row project bindings become a set', () => {
  // "Any project" must have exactly ONE representation. With `undefined`, `[]`,
  // and a stale single `projectTabId` all reachable, every reader would need to
  // test for three things and one would eventually forget.
  const rowMode = (row: Record<string, unknown>): TiledDispatchState => ({
    lanes: [{}], rows: [{ length: 1, ...row }], focusedLane: 0,
  })
  const rowOf = (stage: TiledDispatchState) => stage.rows![0]!

  it('folds a legacy single binding into the set and stops writing the old field', () => {
    const restored = normalizeStage(rowMode({ projectTabId: 'tab-a' }))

    expect(rowOf(restored).projectTabIds).toEqual(['tab-a'])
    expect(rowOf(restored).projectTabId).toBeUndefined()
  })

  it('prefers an explicit set over a stale legacy field', () => {
    // Both surviving means a partial write or an upgrade/downgrade cycle; the
    // plural field is the one the user's last edit produced.
    const restored = normalizeStage(
      rowMode({ projectTabId: 'tab-stale', projectTabIds: ['tab-a', 'tab-b'] }),
    )

    expect(rowOf(restored).projectTabIds).toEqual(['tab-a', 'tab-b'])
    expect(rowOf(restored).projectTabId).toBeUndefined()
  })

  it('collapses an empty set to absent', () => {
    const restored = normalizeStage(rowMode({ projectTabIds: [] }))

    expect(rowOf(restored).projectTabIds).toBeUndefined()
  })

  it('leaves an UNBOUND row untouched by reference', () => {
    // The common case, and the one that would break everything quietly: if
    // normalization rebuilt plain rows, the lane-selection race check — which
    // compares row objects across an async wake — would see a different object
    // every time and drop every selection.
    const plain: TiledDispatchState = { lanes: [{}], rows: [{ length: 1 }], focusedLane: 0 }

    expect(normalizeStage(plain)).toBe(plain)
  })

  it('leaves a healthy multi-project row untouched by reference', () => {
    // Row identity is load-bearing: the lane-selection race check compares row
    // objects across a wake, so a normalization that rebuilt every row would
    // make every selection drop.
    const healthy = rowMode({ projectTabIds: ['tab-a', 'tab-b'] })

    expect(normalizeStage(healthy)).toBe(healthy)
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
