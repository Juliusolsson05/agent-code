import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useDispatchActions } from '@renderer/workspace/hook/actions/dispatch'
import {
  insertLaneRightIntoGrid,
  insertRowBelowInGrid,
  removeRowFromGrid,
} from '@renderer/workspace/dispatch/gridShape'
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
  rows?: { length: number }[]
  lanes?: number
} = {}) {
  const order: string[] = []
  const state = {
    activeTabId: 'tab-a',
    dispatchMode: {
      scope: 'global' as const,
      tiled: {
        // Default [1, 2] — a first row of one lane, then the row races target.
        lanes: [
          { selectedSessionId: LIVE },
          ...Array.from({ length: (options.lanes ?? 3) - 1 }, () => ({})),
        ],
        rows: options.rows ?? [{ length: 1 }, { length: 2 }],
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
    const { hook, order, ensureSessionLive, written } = harness()

    await act(async () => {
      await hook.result.current.selectTiledLaneSession(1, HIBERNATED)
    })

    expect(ensureSessionLive).toHaveBeenCalledWith(HIBERNATED, 'dispatch-lane.select')
    // Order is the contract: a lane written first is a dead pane the user can
    // type into while the wake is still in flight.
    expect(order).toEqual(['wake', 'write-lane'])
    // `order` alone would pass on a write the reducer's bounds check rejected,
    // because the harness records the setState CALL. Assert the lane actually
    // took the session.
    expect(written).toEqual([1])
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

/**
 * Apply a REAL grid mutation while the wake is in flight.
 *
 * WHY the real functions and not a hand-built next-shape: the fix depends on
 * those mutations preserving untouched row objects by reference, which is what
 * lets identity distinguish "this row grew" from "this is a different row".
 * A hand-written reshape with fresh objects tests the test's idea of the
 * reducers, not the reducers — and would make the follow cases fail for a
 * reason that never happens in the product.
 */
function reshapeWith(
  mutate: (tiled: NonNullable<NonNullable<WorkspaceState['dispatchMode']>['tiled']>) =>
    ReturnType<typeof insertLaneRightIntoGrid>,
) {
  return (ref: { current: WorkspaceState }) => {
    const tiled = ref.current.dispatchMode!.tiled!
    const next = mutate(tiled)
    if (!next) throw new Error('reshape refused; the fixture is wrong')
    ref.current = {
      ...ref.current,
      dispatchMode: { ...ref.current.dispatchMode!, tiled: next },
    } as WorkspaceState
  }
}

describe('a reshape while the wake is in flight', () => {
  // `lanes` is flat and row-major, so a lane added or removed in an EARLIER row
  // shifts every later index. setTiledLaneSession's bounds check catches an
  // index that fell off the end, but an index that is merely now a DIFFERENT
  // row's lane is still in range — the write would land in the wrong row. The
  // gesture therefore captures a (row, column) and re-derives the flat index
  // after the wake.
  it('follows the target lane when an earlier row grows under it', async () => {
    // Real New Lane in row 0: [1,2] -> [2,2]. Target slides from flat 2 to 3.
    const { hook, written } = harness({
      duringWake: reshapeWith(tiled => insertLaneRightIntoGrid(tiled, 0)),
    })

    // Aim at row 1, column 1 of a [1, 2] grid — flat index 2.
    await act(async () => {
      await hook.result.current.selectTiledLaneSession(2, HIBERNATED)
    })

    // Re-derived to flat 3. Writing the captured 2 would have landed on row 1's
    // FIRST lane — a slot the user did not choose.
    expect(written).toEqual([3])
  })

  it('drops the write when a row above the target is removed', async () => {
    // THE case an earlier version of this test got wrong, and the reason a real
    // bug shipped green: with only two rows, removing row 0 leaves the stale
    // index off the END of the array, so the write dropped for a reason that
    // had nothing to do with row identity. THREE rows is what distinguishes
    // them — index 1 is still in range, but it now names a different row.
    const { hook, order, written } = harness({
      rows: [{ length: 1 }, { length: 2 }, { length: 2 }],
      lanes: 5,
      // Real Remove Row on row 0. Index 1 stays in range but now names old row 2.
      duringWake: reshapeWith(tiled => removeRowFromGrid(tiled, 0)),
    })

    await act(async () => {
      await hook.result.current.selectTiledLaneSession(2, HIBERNATED)
    })

    // Without the identity check this wrote into the old row 2 — a lane in a
    // row the user never touched, evicting whatever they were watching.
    expect(written).toEqual([])
    expect(order).toEqual(['wake'])
  })

  it('drops the write when a row is inserted above the target', async () => {
    // Same class, opposite direction, and reachable with no confirmation
    // dialog at all: New Row while a wake is in flight.
    // A [2,2] fixture on purpose: New Row inherits the source row's length, so
    // the inserted row is 2 lanes wide and the target's column still EXISTS in
    // it. That is what forces the identity check to be the thing that catches
    // this — with a 1-lane fixture the write would drop on the column bound and
    // the test would pass without the fix.
    const { hook, written } = harness({
      rows: [{ length: 2 }, { length: 2 }],
      lanes: 4,
      duringWake: reshapeWith(tiled => insertRowBelowInGrid(tiled, 0)),
    })

    // Row 1, column 0 of [2,2] — flat 2.
    await act(async () => {
      await hook.result.current.selectTiledLaneSession(2, HIBERNATED)
    })

    expect(written).toEqual([])
  })
})
