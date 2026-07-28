import { describe, expect, it } from 'vitest'

import {
  MIN_DISPATCH_TILES,
  removeLaneFromTiled,
} from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import type { SessionId, TiledDispatchState } from '@renderer/workspace/types'

// removeLaneFromTiled is the whole behaviour of the two lane-removal commands.
// It is pinned here rather than through the hook because the interesting part
// is pure: which lane survives, where focus lands, and when the removal is
// refused. Driving it through React would test the wiring, not the rules.

const lane = (id: string): { selectedSessionId: SessionId } => ({
  selectedSessionId: id as SessionId,
})

const tiled = (
  ids: string[],
  focusedLane: number,
  ratios?: number[],
): TiledDispatchState => ({
  lanes: ids.map(lane),
  focusedLane,
  ...(ratios ? { ratios } : {}),
})

const idsOf = (state: TiledDispatchState | null): (string | undefined)[] =>
  (state?.lanes ?? []).map(l => l.selectedSessionId)

describe('removeLaneFromTiled', () => {
  it('removes the lane at the given index and keeps the rest in order', () => {
    // The bug this whole feature exists for: shrinking by COUNT drops the tail,
    // so the finished agent in the middle survives and everything after it
    // shifts. Removing by index has to leave both neighbours untouched.
    const next = removeLaneFromTiled(tiled(['a', 'b', 'c', 'd'], 0), 1)
    expect(idsOf(next)).toEqual(['a', 'c', 'd'])
  })

  it('keeps the same lane focused when an earlier lane is removed', () => {
    // Indices shift down by one, so holding focusedLane constant would silently
    // move focus to the NEXT agent. The user removed some other lane; the lane
    // they were watching must stay the lane they are watching.
    const next = removeLaneFromTiled(tiled(['a', 'b', 'c', 'd'], 2), 0)
    expect(idsOf(next)).toEqual(['b', 'c', 'd'])
    expect(next?.focusedLane).toBe(1)
    expect(next?.lanes[next.focusedLane]?.selectedSessionId).toBe('c')
  })

  it('leaves focus alone when a later lane is removed', () => {
    const next = removeLaneFromTiled(tiled(['a', 'b', 'c', 'd'], 1), 3)
    expect(next?.focusedLane).toBe(1)
    expect(next?.lanes[next.focusedLane]?.selectedSessionId).toBe('b')
  })

  it('clamps focus into range when the last lane was the focused one', () => {
    // Without the clamp, focusedLane points one past the end and the layout
    // renders no focused lane at all.
    const next = removeLaneFromTiled(tiled(['a', 'b', 'c'], 2), 2)
    expect(idsOf(next)).toEqual(['a', 'b'])
    expect(next?.focusedLane).toBe(1)
  })

  it('always drops stored ratios', () => {
    // Ratios are positional. Carrying them across a removal lays the surviving
    // lanes out against boundaries that no longer exist.
    const next = removeLaneFromTiled(tiled(['a', 'b', 'c'], 0, [0.2, 0.3, 0.5]), 1)
    expect(next?.ratios).toBeUndefined()
  })

  it('refuses at the minimum lane count', () => {
    // Emptying the layout is Dispatch Mode's job. Returning null lets the
    // caller hand back the previous state untouched instead of writing an
    // identical object.
    const atFloor = tiled(Array.from({ length: MIN_DISPATCH_TILES }, (_, i) => `a${i}`), 0)
    expect(removeLaneFromTiled(atFloor, 0)).toBeNull()
  })

  it('refuses an out-of-range or non-integer index', () => {
    // A stale keybind or a command firing against a since-shrunk grid must be
    // inert rather than throwing or silently removing the wrong lane.
    const state = tiled(['a', 'b', 'c'], 0)
    expect(removeLaneFromTiled(state, -1)).toBeNull()
    expect(removeLaneFromTiled(state, 3)).toBeNull()
    expect(removeLaneFromTiled(state, 1.5)).toBeNull()
  })

  it('does not mutate the input state', () => {
    // The reducer spreads this result into workspace state; a mutated input
    // would corrupt the snapshot the caller compared against.
    const state = tiled(['a', 'b', 'c'], 1)
    removeLaneFromTiled(state, 0)
    expect(idsOf(state)).toEqual(['a', 'b', 'c'])
    expect(state.focusedLane).toBe(1)
  })
})
