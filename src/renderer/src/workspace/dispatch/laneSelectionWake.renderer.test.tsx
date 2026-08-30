import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useDispatchActions } from '@renderer/workspace/hook/actions/dispatch'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'

// #690: a hibernated agent must be woken BEFORE it is placed in a lane.
//
// Rehydrate deliberately does not respawn detached sessions — they survive a
// restart as metadata with no provider process. Placing one straight into a
// lane renders a pane that looks fine and then rejects the first prompt with
// "Cannot deliver prompt: <id> is not a live agent session" (main logs
// `reason: never-owned`). Agent-index navigation already woke; the four
// in-layout selection gestures did not.
//
// These assert the ORDER, not just that a wake happened: writing the lane first
// exposes a dead pane the user can type into during the gap, which is the exact
// state being fixed.

const LIVE = 'live-session' as SessionId
const HIBERNATED = 'hibernated-session' as SessionId

function harness(options: {
  wakeRejects?: boolean
  duringWake?: (ref: { current: WorkspaceState }) => void
} = {}) {
  const order: string[] = []
  const state = {
    activeTabId: 'tab-a',
    dispatchMode: {
      scope: 'global' as const,
      tiled: {
        // [1, 2] — a first row of one lane, then the row the races target.
        lanes: [{ selectedSessionId: LIVE }, {}, {}],
        rows: [{ length: 1 }, { length: 2 }],
        focusedLane: 0,
      },
    },
    sessions: {
      [LIVE]: { cwd: '/work/a', kind: 'claude' as const },
      [HIBERNATED]: { cwd: '/work/b', kind: 'claude' as const },
    },
  }
  // Only HIBERNATED is detached; LIVE is grid-placed and owned by a tile tree,
  // so it was respawned at rehydrate and needs no wake.
  const stateRef = {
    current: {
      ...state,
      detachedSessions: {
        [HIBERNATED]: { sessionId: HIBERNATED, surface: 'dispatch', projectTabId: 'tab-b' },
      },
    } as unknown as WorkspaceState,
  }

  const written: number[] = []
  const setState = vi.fn((updater: unknown) => {
    order.push('write-lane')
    // Run the reducer against current state so the lane index it targets is
    // observable — the whole point of the reshape case below.
    if (typeof updater === 'function') {
      const before = JSON.stringify(stateRef.current.dispatchMode?.tiled?.lanes)
      const next = (updater as (p: WorkspaceState) => WorkspaceState)(stateRef.current)
      const after = next.dispatchMode?.tiled?.lanes ?? []
      if (JSON.stringify(after) !== before) {
        written.push(after.findIndex(lane => lane.selectedSessionId === HIBERNATED))
      }
      stateRef.current = next
    }
    return updater
  })
  const ensureSessionLive = vi.fn(async () => {
    order.push('wake')
    // Anything the caller wants to happen WHILE the wake is in flight — a row
    // removed, a lane spliced — lands here, which is the only honest way to
    // exercise a race in a reducer this shape.
    options.duringWake?.(stateRef)
    if (options.wakeRejects) throw new Error('boom')
    return { sessionId: HIBERNATED, builtInMcpDomains: undefined }
  })
  const showToast = vi.fn()

  const hook = renderHook(() =>
    useDispatchActions(
      state,
      setState as never,
      vi.fn(),
      vi.fn(),
      { stateRef } as unknown as WorkspaceRefs,
      ensureSessionLive as never,
      showToast,
    ),
  )
  return { hook, order, setState, ensureSessionLive, showToast, written, stateRef }
}

describe('selecting an agent into a lane', () => {
  it('wakes a hibernated agent BEFORE writing the lane', async () => {
    const { hook, order, ensureSessionLive } = harness()

    await act(async () => {
      await hook.result.current.selectTiledLaneSession(1, HIBERNATED)
    })

    expect(ensureSessionLive).toHaveBeenCalledWith(HIBERNATED, 'dispatch-lane.select')
    // Order is the contract: a lane written first is a dead pane the user can
    // type into while the wake is still in flight.
    expect(order).toEqual(['wake', 'write-lane'])
  })

  it('does not place an agent it could not wake', async () => {
    // Leaving the lane on its previous occupant is honest; showing a pane whose
    // backend refused to come back is not, and it reproduces the original
    // failure one keystroke later.
    const { hook, order, showToast } = harness({ wakeRejects: true })

    await act(async () => {
      await hook.result.current.selectTiledLaneSession(1, HIBERNATED)
    })

    expect(order).toEqual(['wake'])
    expect(showToast).toHaveBeenCalled()
  })

  it('does not wake a grid-placed session', async () => {
    // Owned by a tile tree, so rehydrate already respawned it. Paying a wake
    // round-trip on every ordinary selection would make the common gesture
    // async for nothing.
    const { hook, order, ensureSessionLive } = harness()

    await act(async () => {
      await hook.result.current.selectTiledLaneSession(1, LIVE)
    })

    expect(ensureSessionLive).not.toHaveBeenCalled()
    expect(order).toEqual(['write-lane'])
  })
})

describe('a reshape while the wake is in flight', () => {
  // `lanes` is flat and row-major, so a lane added or removed in an EARLIER row
  // shifts every later index. setTiledLaneSession's bounds check catches an
  // index that fell off the end, but an index that is merely now a DIFFERENT
  // row's lane is still in range — the write would land in the wrong row. The
  // gesture therefore captures a (row, column) and re-derives the flat index
  // after the wake.
  it('follows the target lane when an earlier row grows under it', async () => {
    const { hook, written } = harness({
      duringWake: ref => {
        const tiled = ref.current.dispatchMode!.tiled!
        // New Lane in row 0: [1,2] -> [2,2]. The target slides from flat 2 to 3.
        ref.current = {
          ...ref.current,
          dispatchMode: {
            ...ref.current.dispatchMode!,
            tiled: {
              ...tiled,
              lanes: [tiled.lanes[0]!, {}, ...tiled.lanes.slice(1)],
              rows: [{ length: 2 }, { length: 2 }],
            },
          },
        } as WorkspaceState
      },
    })

    // Aim at row 1, column 1 of a [1, 2] grid — flat index 2.
    await act(async () => {
      await hook.result.current.selectTiledLaneSession(2, HIBERNATED)
    })

    // Re-derived to flat 3. Writing the captured 2 would have landed on row 1's
    // FIRST lane — a slot the user did not choose.
    expect(written).toEqual([3])
  })

  it('drops the write when the target row is gone', async () => {
    // Rows have no durable identity, so a row removed ABOVE the target changes
    // the target's own index and it can no longer be located. Dropping is the
    // honest outcome: silently retargeting a slot the user did not choose is
    // the class of surprise this branch exists to remove. Narrow enough to
    // accept — it needs a reshape to land inside a wake round-trip.
    const { hook, order } = harness({
      duringWake: ref => {
        ref.current = {
          ...ref.current,
          dispatchMode: {
            ...ref.current.dispatchMode!,
            tiled: { lanes: [{}], rows: [{ length: 1 }], focusedLane: 0 },
          },
        } as WorkspaceState
      },
    })

    await act(async () => {
      await hook.result.current.selectTiledLaneSession(2, HIBERNATED)
    })

    expect(order).toEqual(['wake'])
  })
})
