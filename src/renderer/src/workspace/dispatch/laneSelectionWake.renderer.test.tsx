import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useDispatchActions } from '@renderer/workspace/hook/actions/dispatch'
import {
  insertLaneRightIntoGrid,
  insertRowBelowInGrid,
  removeRowFromGrid,
} from '@renderer/workspace/dispatch/gridShape'
import { workspaceWithoutSessions } from '@renderer/workspace/pool'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'

// #690: a hibernated agent must be woken BEFORE it is placed in a lane.
//
// Rehydrate deliberately spawns only the focused lane's occupant — every other
// session survives a restart as metadata with no provider process. Placing one
// straight into a lane renders a pane that looks fine and then rejects the
// first prompt with "Cannot deliver prompt: <id> is not a live agent session"
// (main logs `reason: never-owned`). Agent-index navigation already woke; the
// four in-layout selection gestures did not.
//
// WHAT DECIDES "hibernated" changed with #992, and the fixture with it. It was
// STRUCTURAL: a session with a `detachedSessions` record had not been respawned,
// a tile leaf had. Both containers are gone, so the gesture asks the RUNTIME:
// `processStatus === 'started'` is the only thing that skips the wake. The
// harness therefore feeds `latestRuntimesRef`, and a fixture that forgot to
// would make every session look hibernated — which is the safe direction to be
// wrong in, and is pinned as its own case below.
//
// These assert the ORDER, not just that a wake happened: writing the lane first
// exposes a dead pane the user can type into during the gap, which is the exact
// state being fixed.

const LIVE = 'live-session' as SessionId
const HIBERNATED = 'hibernated-session' as SessionId
const EXPANDED_PARENT = 'expanded-parent' as SessionId

function harness(options: {
  wakeRejects?: boolean
  duringWake?: (ref: { current: WorkspaceState }) => void
  rows?: NonNullable<WorkspaceState['stage']['rows']>
  lanes?: number
  /** Override the runtime map, e.g. to model a session whose backend died. */
  runtimes?: Record<SessionId, SessionRuntime>
} = {}) {
  const order: string[] = []
  const state = {
    activeTabId: 'tab-a',
    stage: {
      // Default [1, 2] — a first row of one lane, then the row races target.
      lanes: [
        { selectedSessionId: LIVE },
        ...Array.from({ length: (options.lanes ?? 3) - 1 }, () => ({})),
      ],
      rows: options.rows ?? [{ length: 1 }, { length: 2 }],
      focusedLane: 0,
    },
    tabs: [{ id: 'tab-a', title: 'A' }, { id: 'tab-b', title: 'B' }],
    pinnedSessionIds: [],
    sessions: {
      [LIVE]: { cwd: '/work/a', kind: 'claude' as const, projectId: 'tab-a', joinedAt: 0 },
      [HIBERNATED]: { cwd: '/work/b', kind: 'claude' as const, projectId: 'tab-b', joinedAt: 0 },
      [EXPANDED_PARENT]: { cwd: '/work/a', kind: 'claude' as const, projectId: 'tab-a', joinedAt: 0 },
    },
  } satisfies WorkspaceState
  const stateRef = { current: state as WorkspaceState }
  // LIVE has a running backend; HIBERNATED is exactly what rehydrate seeds for
  // a session it did not spawn (processStatus 'idle').
  const latestRuntimesRef = {
    current: options.runtimes ?? {
      [LIVE]: { ...emptyRuntime(), processStatus: 'started' as const },
      [HIBERNATED]: emptyRuntime(),
    },
  }

  const written: number[] = []
  const setState = vi.fn((updater: unknown) => {
    order.push('write-lane')
    // Run the reducer against current state so the lane index it targets is
    // observable — the whole point of the reshape case below.
    if (typeof updater === 'function') {
      const before = JSON.stringify(stateRef.current.stage.lanes)
      const next = (updater as (p: WorkspaceState) => WorkspaceState)(stateRef.current)
      const after = next.stage.lanes ?? []
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

  // The runtime-setter stub records badge clears like the real store setter
  // would apply them; selectTiledLaneSession's synchronous branch writes the
  // lane through it, and the pooled-spawn badge clear rides the same call.
  const setRuntimes = vi.fn(updater => { updater({}) })
  const hook = renderHook(() =>
    useDispatchActions(
      setState as never,
      setRuntimes as never,
      { stateRef, latestRuntimesRef } as unknown as WorkspaceRefs,
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

  it.each([
    { name: 'a close that prunes ANOTHER row', removed: EXPANDED_PARENT, expanded: [EXPANDED_PARENT] },
    { name: 'a close that prunes nothing (control)', removed: EXPANDED_PARENT, expanded: [] },
  ])('still places the woken agent through $name', async ({ removed, expanded }) => {
    // The regression this pins is not in this file's code at all, which is why
    // it survived review the first time: `workspaceWithoutSessions` prunes row
    // METADATA on every close, and a version of `scrubGridRowMetadata` that
    // rebuilt every row — including the rows it changed nothing about — made
    // the identity check below read "the grid moved" for a close that touched
    // a different row entirely.
    //
    // The user-visible result is the worst kind of silent failure: the agent
    // IS woken, a provider process starts, and then nothing is placed and no
    // toast is shown. The window is wide — a cold wake can hold it open for
    // 30s — and every close path reaches it (Close Agent, Close Old Agents,
    // Close Idle Orchestration Agents, MCP agents.close).
    //
    // The control row is what makes this a test rather than a coincidence: a
    // close that scrubs nothing has always been safe, because the helper
    // returns the same stage object.
    const { hook, written } = harness({
      rows: [{ length: 1, ...(expanded.length > 0 ? { expandedParents: expanded } : {}) }, { length: 2 }],
      duringWake: ref => {
        ref.current = workspaceWithoutSessions(ref.current, [removed])
      },
    })

    await act(async () => {
      await hook.result.current.selectTiledLaneSession(1, HIBERNATED)
    })

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

  it('does not wake a session whose backend is already running', async () => {
    // Paying a wake round-trip on every ordinary selection would make the
    // common gesture async for nothing — and until #992 it DID, for every lane
    // agent, because the structural test called all of them hibernated.
    const { hook, order, ensureSessionLive } = harness()

    await act(async () => {
      await hook.result.current.selectTiledLaneSession(1, LIVE)
    })

    expect(ensureSessionLive).not.toHaveBeenCalled()
    expect(order).toEqual(['write-lane'])
  })

  it.each(['failed', 'exited'] as const)('wakes a session whose backend is %s, not only one that never started', async status => {
    // The gap the structural test had: a tile leaf whose respawn failed at
    // rehydrate, or whose process died since, "was not detached" and so was
    // written into a lane un-woken. The wake path is also the retry path, so
    // selecting a dead agent is now how the user brings it back.
    const { hook, order, ensureSessionLive } = harness({
      runtimes: {
        [LIVE]: { ...emptyRuntime(), processStatus: status },
        [HIBERNATED]: emptyRuntime(),
      },
    })

    await act(async () => {
      await hook.result.current.selectTiledLaneSession(1, LIVE)
    })

    expect(ensureSessionLive).toHaveBeenCalledWith(LIVE, 'dispatch-lane.select')
    expect(order[0]).toBe('wake')
  })

  it('wakes a session with NO runtime entry rather than assuming it is live', async () => {
    // Fail-safe direction: an unknown runtime costs one idempotent recover
    // round-trip; an assumed-live one costs a prompt rejected by main.
    const { hook, order, ensureSessionLive } = harness({ runtimes: {} })

    await act(async () => {
      await hook.result.current.selectTiledLaneSession(1, LIVE)
    })

    expect(ensureSessionLive).toHaveBeenCalledWith(LIVE, 'dispatch-lane.select')
    expect(order).toEqual(['wake', 'write-lane'])
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
  mutate: (tiled: WorkspaceState['stage']) =>
    ReturnType<typeof insertLaneRightIntoGrid>,
) {
  return (ref: { current: WorkspaceState }) => {
    const tiled = ref.current.stage
    const next = mutate(tiled)
    if (!next) throw new Error('reshape refused; the fixture is wrong')
    ref.current = {
      ...ref.current,
      stage: next,
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
