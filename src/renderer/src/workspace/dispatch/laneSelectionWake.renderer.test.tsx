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

function harness(options: { wakeRejects?: boolean } = {}) {
  const order: string[] = []
  const state = {
    activeTabId: 'tab-a',
    dispatchMode: {
      scope: 'global' as const,
      tiled: {
        lanes: [{ selectedSessionId: LIVE }, {}],
        rows: [{ length: 2 }],
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

  const setState = vi.fn((updater: unknown) => {
    order.push('write-lane')
    return updater
  })
  const ensureSessionLive = vi.fn(async () => {
    order.push('wake')
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
  return { hook, order, setState, ensureSessionLive, showToast }
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
