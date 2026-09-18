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
  /** Ids to record as detached (hibernated, no live backend). */
  detachedIds?: SessionId[]
  /** Anything the caller wants to happen WHILE a wake is in flight. */
  duringWake?: (ref: { current: WorkspaceState }) => void
  /** Make the wake fail. */
  wakeRejects?: boolean
} = {}) {
  const candidate = options.tiledFocus ?? options.classicFocus ?? options.gridFocus
  const sessions: Record<string, { cwd: string; kind: 'claude' }> = {}
  // The focus candidate only exists as a session when the test says so — a
  // stale/absent id must degrade to an empty lane, never a phantom occupant.
  if (candidate && !options.candidateAbsent) {
    sessions[candidate] = { cwd: `/work/${candidate}`, kind: 'claude' }
  }
  // A second, VALID focus target for the focus-moved-during-wake case: live
  // and recorded, so only the wake-window movement distinguishes it.
  sessions['moved-to-focus'] = { cwd: '/work/moved-to', kind: 'claude' }
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
    detachedSessions: Object.fromEntries(
      (options.detachedIds ?? []).map(id => [
        id,
        { sessionId: id, surface: 'dispatch', projectTabId: 'tab-b' },
      ]),
    ),
  }
  const stateRef = { current: state as unknown as WorkspaceState }
  // Order is the contract for the wake cases: a lane written before the wake
  // is the #690 dead-pane state all over again.
  const order: string[] = []
  // Apply updaters eagerly so the resulting tiled state is observable — the
  // whole point of these tests is what the reducer WROTE, not that it ran.
  const setState = vi.fn((updater: unknown) => {
    if (typeof updater === 'function') {
      order.push('write')
      stateRef.current = (updater as (p: WorkspaceState) => WorkspaceState)(stateRef.current)
    }
    return updater
  })
  const ensureSessionLive = vi.fn(async () => {
    order.push('wake')
    options.duringWake?.(stateRef)
    if (options.wakeRejects) throw new Error('boom')
    return { sessionId: candidate, builtInMcpDomains: undefined }
  })
  const showToast = vi.fn()
  const hook = renderHook(() =>
    useDispatchActions(
      state,
      setState as never,
      vi.fn(),
      { stateRef } as unknown as WorkspaceRefs,
      ensureSessionLive as never,
      showToast,
    ),
  )
  return { hook, stateRef, order, ensureSessionLive, showToast }
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

describe('a detached seed is woken before it is written (#690 parity)', () => {
  // The seed is a lane placement like any other: a hibernated agent written
  // into a lane without a wake renders a pane that rejects the first prompt
  // with "not a live agent session". The strip-selection gesture wakes for
  // exactly this reason; entry seeding must not be the one path exempt from
  // the rule. In an ordinary session EVERY dispatch agent is detached, so
  // this is the COMMON seeding path, not an edge case.

  it('wakes a hibernated focus before seeding lane 0', async () => {
    const { hook, stateRef, order, ensureSessionLive } = harness({
      classicFocus: CLASSIC_FOCUS,
      detachedIds: [CLASSIC_FOCUS],
    })

    await act(async () => {
      await hook.result.current.enterTiledDispatch([2])
    })

    expect(ensureSessionLive).toHaveBeenCalledWith(CLASSIC_FOCUS, 'grid-dispatch.entry-seed')
    // Order is the contract: writing the lane first is the dead-pane state.
    expect(order).toEqual(['wake', 'write'])
    expect(stateRef.current.dispatchMode?.tiled?.lanes[0]?.selectedSessionId)
      .toBe(CLASSIC_FOCUS)
  })

  it('enters without a seed when the wake fails', async () => {
    // Entry is the user's primary request; a failed wake costs the seed, not
    // the layout. Showing a pane whose backend refused to come back is the
    // exact failure mode the wake exists to prevent.
    const { hook, stateRef, order, showToast } = harness({
      classicFocus: CLASSIC_FOCUS,
      detachedIds: [CLASSIC_FOCUS],
      wakeRejects: true,
    })

    await act(async () => {
      await hook.result.current.enterTiledDispatch([2])
    })

    expect(order).toEqual(['wake', 'write'])
    expect(showToast).toHaveBeenCalled()
    const tiled = stateRef.current.dispatchMode?.tiled
    expect(tiled?.lanes).toHaveLength(2)
    expect(tiled?.lanes.every(lane => lane.selectedSessionId === undefined)).toBe(true)
  })

  it('does not wake a grid-placed focus', async () => {
    // Owned by a tile tree, so rehydrate already respawned it — the identical
    // predicate selectTiledLaneSession uses. A spurious wake would make every
    // ordinary entry pay a recover round-trip for nothing.
    const { hook, order, ensureSessionLive } = harness({ gridFocus: GRID_FOCUS })

    await act(async () => {
      await hook.result.current.enterTiledDispatch([2])
    })

    expect(ensureSessionLive).not.toHaveBeenCalled()
    expect(order).toEqual(['write'])
  })

  it('drops the seed when focus moves during the wake', async () => {
    // The wake window is up to 30s cold. The new focus was neither validated
    // nor woken on this path, and seeding it from inside the sync updater
    // would raw-write a possibly-detached id — the gap this describe closes.
    // Dropping mirrors selectTiledLaneSession's membership-change drop:
    // predictable over clever.
    const { hook, stateRef, ensureSessionLive } = harness({
      classicFocus: CLASSIC_FOCUS,
      detachedIds: [CLASSIC_FOCUS],
      duringWake: ref => {
        ref.current = {
          ...ref.current,
          dispatchMode: { scope: 'global', focusedSessionId: 'moved-to-focus' as SessionId },
        }
      },
    })

    await act(async () => {
      await hook.result.current.enterTiledDispatch([2])
    })

    expect(ensureSessionLive).toHaveBeenCalledWith(CLASSIC_FOCUS, 'grid-dispatch.entry-seed')
    const lanes = stateRef.current.dispatchMode?.tiled?.lanes ?? []
    expect(lanes.every(lane => lane.selectedSessionId === undefined)).toBe(true)
  })
})
