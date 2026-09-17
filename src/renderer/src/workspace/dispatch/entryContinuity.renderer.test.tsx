import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useDispatchActions } from '@renderer/workspace/hook/actions/dispatch'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'

// #977: entering Grid Dispatch must keep the agent the user was commanding.
//
// `enterTiledDispatch` used to build every lane empty. Classic Dispatch
// carefully carried `focusedSessionId` onto the dispatchMode object and then
// dropped it on the floor — no lane received it — so the user turned Grid
// Dispatch on from one focused lane and that lane arrived unoccupied.
//
// This is CONTINUITY, not #681's banned auto-fill: the seeded session is the
// one already focused, never a prediction from the index, and every other
// lane stays empty exactly as #681 requires.

const CLASSIC_FOCUS = 'classic-focus' as SessionId
const GRID_FOCUS = 'grid-focus' as SessionId
const TILED_FOCUS = 'tiled-focus' as SessionId

function harness(options: {
  /** Classic Dispatch focus (`dispatchMode.focusedSessionId`), Dispatch off-grid. */
  classicFocus?: SessionId
  /** The focused pane of the normal grid (active tab's `focusedSessionId`). */
  gridFocus?: SessionId
  /** An existing Grid Dispatch whose focused lane holds this agent. */
  tiledFocus?: SessionId
  /** Ids to record as buried. */
  buriedIds?: SessionId[]
  /** Omit the candidate from `sessions` entirely. */
  candidateAbsent?: boolean
} = {}) {
  const candidate = options.tiledFocus ?? options.classicFocus ?? options.gridFocus
  const sessions: Record<string, { cwd: string; kind: 'claude' }> = {}
  // The focus candidate only exists as a session when the test says so — a
  // stale/absent id must degrade to an empty lane, never a phantom occupant.
  if (candidate && !options.candidateAbsent) {
    sessions[candidate] = { cwd: `/work/${candidate}`, kind: 'claude' }
  }
  const state = {
    activeTabId: 'tab-a',
    tabs: [{
      id: 'tab-a',
      title: 'Work',
      root: { type: 'leaf' as const, sessionId: GRID_FOCUS },
      focusedSessionId: options.gridFocus,
    }],
    dispatchMode: options.tiledFocus
      ? {
          scope: 'global' as const,
          tiled: {
            lanes: [{ selectedSessionId: options.tiledFocus }, {}, {}],
            rows: [{ length: 3 }],
            focusedLane: 0,
          },
        }
      : options.classicFocus
        ? { scope: 'global' as const, focusedSessionId: options.classicFocus }
        : null,
    sessions,
    buried: (options.buriedIds ?? []).map(id => ({ sessionId: id })),
    detachedSessions: {},
  }
  const stateRef = { current: state as unknown as WorkspaceState }
  // Apply updaters eagerly so the resulting tiled state is observable — the
  // whole point of these tests is what the reducer WROTE, not that it ran.
  const setState = vi.fn((updater: unknown) => {
    if (typeof updater === 'function') {
      stateRef.current = (updater as (p: WorkspaceState) => WorkspaceState)(stateRef.current)
    }
    return updater
  })
  const hook = renderHook(() =>
    useDispatchActions(
      state,
      setState as never,
      vi.fn(),
      vi.fn(),
      { stateRef } as unknown as WorkspaceRefs,
      vi.fn() as never,
      vi.fn(),
    ),
  )
  return { hook, stateRef }
}

describe('entering Grid Dispatch keeps the focused agent (#977)', () => {
  it('seeds the classic Dispatch focus into lane 0', async () => {
    const { hook, stateRef } = harness({ classicFocus: CLASSIC_FOCUS })

    await act(async () => {
      await hook.result.current.enterTiledDispatch([2])
    })

    const tiled = stateRef.current.dispatchMode?.tiled
    expect(tiled?.lanes[0]?.selectedSessionId).toBe(CLASSIC_FOCUS)
    // Only lane 0. Seeding every lane is #681's auto-fill, not continuity.
    expect(tiled?.lanes[1]?.selectedSessionId).toBeUndefined()
    // The seeded lane is the focused lane, so the user keeps commanding the
    // agent they were commanding.
    expect(tiled?.focusedLane).toBe(0)
  })

  it('falls back to the focused grid pane when Dispatch was never entered', async () => {
    const { hook, stateRef } = harness({ gridFocus: GRID_FOCUS })

    await act(async () => {
      await hook.result.current.enterTiledDispatch([3])
    })

    const tiled = stateRef.current.dispatchMode?.tiled
    expect(tiled?.lanes[0]?.selectedSessionId).toBe(GRID_FOCUS)
    expect(tiled?.lanes[1]?.selectedSessionId).toBeUndefined()
    expect(tiled?.lanes[2]?.selectedSessionId).toBeUndefined()
  })

  it('prefers the classic Dispatch focus over the grid pane', async () => {
    // Both are live when the user enters Dispatch from a grid tab and then
    // goes straight to Grid Dispatch. The Dispatch focus is the later, more
    // deliberate signal of what the user is commanding.
    const { hook, stateRef } = harness({
      classicFocus: CLASSIC_FOCUS,
      gridFocus: GRID_FOCUS,
    })

    await act(async () => {
      await hook.result.current.enterTiledDispatch([2])
    })

    expect(stateRef.current.dispatchMode?.tiled?.lanes[0]?.selectedSessionId)
      .toBe(CLASSIC_FOCUS)
  })

  it('carries the focused lane of an existing grid on re-entry', async () => {
    // enterTiledDispatch REPLACES an existing grid wholesale; the tiled-aware
    // focus reader means the replacement still starts from the agent the user
    // was looking at, not from lane 0 of the old shape.
    const { hook, stateRef } = harness({ tiledFocus: TILED_FOCUS })

    await act(async () => {
      await hook.result.current.enterTiledDispatch([2])
    })

    expect(stateRef.current.dispatchMode?.tiled?.lanes[0]?.selectedSessionId)
      .toBe(TILED_FOCUS)
  })

  it('leaves every lane empty when the focused id is buried', async () => {
    const { hook, stateRef } = harness({
      classicFocus: CLASSIC_FOCUS,
      buriedIds: [CLASSIC_FOCUS],
    })

    await act(async () => {
      await hook.result.current.enterTiledDispatch([2])
    })

    const lanes = stateRef.current.dispatchMode?.tiled?.lanes ?? []
    expect(lanes.every(lane => lane.selectedSessionId === undefined)).toBe(true)
  })

  it('leaves every lane empty when the focused id is not a live session', async () => {
    const { hook, stateRef } = harness({
      classicFocus: CLASSIC_FOCUS,
      candidateAbsent: true,
    })

    await act(async () => {
      await hook.result.current.enterTiledDispatch([2])
    })

    const lanes = stateRef.current.dispatchMode?.tiled?.lanes ?? []
    expect(lanes.every(lane => lane.selectedSessionId === undefined)).toBe(true)
  })

  it('leaves lane 0 empty when nothing is focused anywhere', async () => {
    const { hook, stateRef } = harness()

    await act(async () => {
      await hook.result.current.enterTiledDispatch([2])
    })

    const lanes = stateRef.current.dispatchMode?.tiled?.lanes ?? []
    expect(lanes.every(lane => lane.selectedSessionId === undefined)).toBe(true)
  })
})
