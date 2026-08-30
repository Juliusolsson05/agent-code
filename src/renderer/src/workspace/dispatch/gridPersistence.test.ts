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
      gridMode({ projectTabId: 'tab-gone' }),
      new Set(['tab-live']),
      new Set<SessionId>(),
    )

    expect(scrubbed!.tiled!.rows![0]!.projectTabId).toBeUndefined()
  })

  it('keeps a binding to a project that survives', () => {
    const scrubbed = scrubGridRowMetadata(
      gridMode({ projectTabId: 'tab-live' }),
      new Set(['tab-live']),
      new Set<SessionId>(),
    )

    expect(scrubbed!.tiled!.rows![0]!.projectTabId).toBe('tab-live')
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
    const clean = gridMode({ projectTabId: 'tab-live' })

    expect(scrubGridRowMetadata(clean, new Set(['tab-live']), new Set<SessionId>()))
      .toBe(clean)
  })

  it('leaves classic Dispatch alone', () => {
    const classic: DispatchModeState = { scope: 'project' }

    expect(scrubGridRowMetadata(classic, new Set<string>(), new Set<SessionId>()))
      .toBe(classic)
  })
})
