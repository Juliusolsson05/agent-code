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
    // Asserting the lane list too, not just the index: without it this passes
    // even if the wrong lane were spliced, since index 1 would still be 'b'.
    expect(idsOf(next)).toEqual(['a', 'b', 'c'])
    expect(next?.focusedLane).toBe(1)
    expect(next?.lanes[next.focusedLane]?.selectedSessionId).toBe('b')
  })

  it('keeps the index when the focused lane itself is removed mid-list', () => {
    // The arm where NEITHER the -1 adjust nor the clamp does anything, and the
    // most common real invocation (Close Agent and Remove Lane on a middle
    // lane). Focus stays put and now shows the ex-successor, which is the
    // cursor-trails-deletion convention the rest of Dispatch already follows.
    // A regression swapping `<` for `<=` in the adjust would leave every other
    // test in this file green and break exactly this case.
    const next = removeLaneFromTiled(tiled(['a', 'b', 'c'], 1), 1)
    expect(idsOf(next)).toEqual(['a', 'c'])
    expect(next?.focusedLane).toBe(1)
    expect(next?.lanes[next.focusedLane]?.selectedSessionId).toBe('c')
  })

  it('keeps focus on lane 0 when lane 0 is removed', () => {
    // Lane 0 is the one selected from the full index rather than its own
    // mini-list, so removing it promotes lane 1 into that role. Focus must not
    // drift off the leftmost lane in the process.
    const next = removeLaneFromTiled(tiled(['a', 'b', 'c'], 0), 0)
    expect(idsOf(next)).toEqual(['b', 'c'])
    expect(next?.focusedLane).toBe(0)
    expect(next?.lanes[0]?.selectedSessionId).toBe('b')
  })

  it('clamps focus into range when the last lane was the focused one', () => {
    // Without the clamp, focusedLane points one past the end and the layout
    // renders no focused lane at all.
    const next = removeLaneFromTiled(tiled(['a', 'b', 'c'], 2), 2)
    expect(idsOf(next)).toEqual(['a', 'b'])
    expect(next?.focusedLane).toBe(1)
  })

  it('drops the removed lane weight but keeps the index-sidebar fraction', () => {
    // ratios[0] is the INDEX-SIDEBAR fraction, not a lane boundary — only
    // ratios.slice(1) are lane weights. Dropping the array wholesale would
    // snap a deliberately-dragged sidebar back to its default, which is an
    // unrelated setting the user never asked to change.
    //
    // The surviving weights must number exactly lanes.length, or
    // normalizedLaneWeights discards them and falls back to even distribution.
    const next = removeLaneFromTiled(tiled(['a', 'b', 'c'], 0, [0.25, 0.1, 0.6, 0.3]), 1)
    expect(next?.ratios).toEqual([0.25, 0.1, 0.3])
    expect(next?.ratios?.length).toBe((next?.lanes.length ?? 0) + 1)
  })

  it('leaves ratios undefined when none were stored', () => {
    const next = removeLaneFromTiled(tiled(['a', 'b', 'c'], 0), 1)
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
