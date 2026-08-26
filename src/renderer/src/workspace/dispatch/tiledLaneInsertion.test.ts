import { describe, expect, it } from 'vitest'

import {
  insertLaneRightIntoTiled,
  MAX_DISPATCH_TILES,
} from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import type {
  DispatchLane,
  SessionId,
  TiledDispatchState,
  WorkspaceState,
} from '@renderer/workspace/types'

const lane = (id: string): DispatchLane => ({ selectedSessionId: id as SessionId })

function makeState(visibleIds: string[]): WorkspaceState {
  return {
    tabs: visibleIds.map((id, index) => ({
      id: `tab-${id}`,
      title: `project-${index}`,
      root: { type: 'leaf', sessionId: id },
      focusedSessionId: id,
    })),
    activeTabId: `tab-${visibleIds[0]}`,
    dispatchMode: { scope: 'global' },
    sessions: Object.fromEntries(
      visibleIds.map(id => [id, { cwd: `/work/${id}`, kind: 'claude' as const }]),
    ),
    detachedSessions: {},
    buried: [],
    pinnedSessionIds: [],
  }
}

function tiled(
  ids: Array<string | undefined>,
  focusedLane: number,
  ratios?: number[],
): TiledDispatchState {
  return {
    lanes: ids.map(id => id ? lane(id) : {}),
    focusedLane,
    ...(ratios ? { ratios } : {}),
  }
}

const idsOf = (state: TiledDispatchState | null): Array<string | undefined> =>
  (state?.lanes ?? []).map(candidate => candidate.selectedSessionId)

describe('insertLaneRightIntoTiled', () => {
  it('inserts after the focused lane and auto-fills the first unclaimed visible agent', () => {
    // Appending by count cannot satisfy this contract: with B focused it would
    // place D after C, separating the new working lane from the command target
    // that motivated it. Existing selections on both sides must stay put.
    const current = tiled(['a', 'b', 'c'], 1)
    const next = insertLaneRightIntoTiled(makeState(['a', 'b', 'c', 'd']), current, 1)

    expect(idsOf(next)).toEqual(['a', 'b', 'd', 'c'])
    expect(next?.focusedLane).toBe(1)
    expect(next?.lanes[next.focusedLane]?.selectedSessionId).toBe('b')
  })

  it('naturally appends when the focused lane is already last', () => {
    const next = insertLaneRightIntoTiled(
      makeState(['a', 'b', 'c']),
      tiled(['a', 'b'], 1),
      1,
    )

    expect(idsOf(next)).toEqual(['a', 'b', 'c'])
    expect(next?.focusedLane).toBe(1)
  })

  it('preserves the focused session when a general caller inserts before it', () => {
    // The command currently passes the focused index, but this helper is public
    // and accepts any lane coordinate. An insertion before focus shifts that
    // session right; preserving only the numeric index would retarget every
    // subsequent keyboard command from C to B.
    const next = insertLaneRightIntoTiled(
      makeState(['a', 'b', 'c', 'd']),
      tiled(['a', 'b', 'c'], 2),
      0,
    )

    expect(idsOf(next)).toEqual(['a', 'd', 'b', 'c'])
    expect(next?.focusedLane).toBe(3)
    expect(next?.lanes[next.focusedLane]?.selectedSessionId).toBe('c')
  })

  it('inserts after lane zero without changing which lane the full index controls', () => {
    const next = insertLaneRightIntoTiled(
      makeState(['a', 'b', 'c']),
      tiled(['a', 'b'], 0),
      0,
    )

    expect(idsOf(next)).toEqual(['a', 'c', 'b'])
    expect(next?.focusedLane).toBe(0)
    expect(next?.lanes[0]?.selectedSessionId).toBe('a')
  })

  it('leaves the inserted lane empty when every visible agent is already represented', () => {
    // Duplicates remain a deliberate user action (`A2!`). Automatic growth must
    // not silently mirror an arbitrary agent just to avoid an empty selector.
    const next = insertLaneRightIntoTiled(makeState(['a', 'b']), tiled(['a', 'b'], 0), 0)

    expect(idsOf(next)).toEqual(['a', undefined, 'b'])
  })

  it('preserves the sidebar and existing proportions while giving the new lane an average share', () => {
    const next = insertLaneRightIntoTiled(
      makeState(['a', 'b', 'c', 'd']),
      tiled(['a', 'b', 'c'], 1, [0.25, 0.1, 0.6, 0.2]),
      1,
    )

    // Average old weight = 0.3. Existing weights remain byte-for-byte stable,
    // which preserves their relative 1:6:2 sizing after normalization.
    expect(next?.ratios).toEqual([0.25, 0.1, 0.6, 0.3, 0.2])
    expect(next?.ratios?.length).toBe((next?.lanes.length ?? 0) + 1)
  })

  it('keeps implicit even sizing implicit', () => {
    const next = insertLaneRightIntoTiled(
      makeState(['a', 'b', 'c']),
      tiled(['a', 'b'], 0),
      0,
    )

    expect(next?.ratios).toBeUndefined()
  })

  it('preserves the sidebar and repairs malformed stored lane weights', () => {
    const next = insertLaneRightIntoTiled(
      makeState(['a', 'b', 'c']),
      tiled(['a', 'b'], 0, [0.3, 1]),
      0,
    )

    expect(next?.ratios).toEqual([0.3, 1, 1, 1])
  })

  it('refuses the lane ceiling and invalid indexes', () => {
    const ids = Array.from({ length: MAX_DISPATCH_TILES }, (_, index) => `a${index}`)
    const state = makeState(ids)
    const atCeiling = tiled(ids, 0)

    expect(insertLaneRightIntoTiled(state, atCeiling, 0)).toBeNull()
    expect(insertLaneRightIntoTiled(makeState(['a', 'b']), tiled(['a', 'b'], 0), -1)).toBeNull()
    expect(insertLaneRightIntoTiled(makeState(['a', 'b']), tiled(['a', 'b'], 0), 2)).toBeNull()
    expect(insertLaneRightIntoTiled(makeState(['a', 'b']), tiled(['a', 'b'], 0), 0.5)).toBeNull()
  })

  it('does not mutate the input state', () => {
    const current = tiled(['a', 'b', 'c'], 1, [0.2, 1, 2, 3])
    insertLaneRightIntoTiled(makeState(['a', 'b', 'c', 'd']), current, 1)

    expect(idsOf(current)).toEqual(['a', 'b', 'c'])
    expect(current.focusedLane).toBe(1)
    expect(current.ratios).toEqual([0.2, 1, 2, 3])
  })
})
