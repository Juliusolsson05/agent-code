import { act } from 'react'
import type { MutableRefObject } from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { UndoCloseStack } from '@renderer/lib/undoClose'
import { useAgentIndexNavigationActions } from '@renderer/workspace/hook/actions/agentIndexNavigation'
import type { SessionActions } from '@renderer/workspace/hook/actions/session'
import type { WorkspaceSetState } from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { WorkspaceState } from '@renderer/workspace/types'

function makeState(): WorkspaceState {
  return {
    tabs: [{
      id: 'tab-a',
      title: 'alpha',
      root: { type: 'leaf', sessionId: 'a1' },
      focusedSessionId: 'a1',
    }],
    activeTabId: 'tab-a',
    // The stage is the workspace (#992): a1 sits in lane 0, lane 1 is empty and
    // focused, so "navigate to A2" means "fill the focused lane with the parked
    // agent". Before the unified layout this fixture had no Dispatch state and
    // these cases exercised the tile-tree swap, which no longer exists.
    dispatchMode: {
      scope: 'global',
      focusedSessionId: 'a1',
      tiled: { focusedLane: 1, lanes: [{ selectedSessionId: 'a1' }, {}], rows: [{ length: 2 }] },
    },
    sessions: {
      a1: { cwd: '/work/alpha/foreground', kind: 'claude' },
      a2: { cwd: '/work/alpha/background', kind: 'codex' },
    },
    detachedSessions: {
      a2: {
        sessionId: 'a2',
        surface: 'dispatch',
        projectTabId: 'tab-a',
        projectTabTitle: 'alpha',
        projectTabIndex: 0,
        detachedAt: 10,
      },
    },
    buried: [],
    pinnedSessionIds: [],
  }
}

function makeRefs(state: WorkspaceState): WorkspaceRefs {
  const ref = <T,>(value: T): MutableRefObject<T> => ({ current: value })
  return {
    stateRef: ref(state),
    latestStateRef: ref(state),
    latestRuntimesRef: ref({}),
    dangerousAgentsRef: ref(false),
    useProxyStreamingRef: ref(false),
    defaultBuiltInMcpDomainsRef: ref([]),
    seenUuidsRef: ref({}),
    latestScreenRef: ref({}),
    undoStackRef: ref(new UndoCloseStack()),
    bootstrapTimersRef: ref(new Map()),
    persistedFeedDebugIdRef: ref({}),
    inFlightFeedDebugIdRef: ref({}),
    paneToastTimers: ref({}),
    pendingAdoptionWindowIdsRef: ref<string[]>([]),
    saveTimerRef: ref(null),
    bootRef: ref(false),
  }
}

function mountNavigation(
  ensureSessionLive: ReturnType<typeof vi.fn>,
  initialState: WorkspaceState = makeState(),
) {
  const refs = makeRefs(initialState)
  let state = refs.stateRef.current
  const setState: WorkspaceSetState = next => {
    state = typeof next === 'function' ? next(state) : next
    refs.stateRef.current = state
    refs.latestStateRef.current = state
  }
  const showToast = vi.fn()
  let actions!: ReturnType<typeof useAgentIndexNavigationActions>

  function Harness(): React.JSX.Element {
    actions = useAgentIndexNavigationActions(
      setState,
      refs,
      { ensureSessionLive } as unknown as SessionActions,
      showToast,
    )
    return <div />
  }

  const mounted = render(<Harness />)
  return { actions, mounted, showToast, getState: () => state, setState }
}

const laneIds = (state: WorkspaceState) =>
  state.dispatchMode?.tiled?.lanes.map(lane => lane.selectedSessionId ?? null)

describe('useAgentIndexNavigationActions', () => {
  it('uses the same navigation result for a stable ID and its UI label', async () => {
    const labeled = mountNavigation(vi.fn().mockResolvedValue('a2'))
    await act(async () => { expect(await labeled.actions.focusAgentByPaneLabel('A2')).toBe(true) })
    const expected = labeled.getState()
    labeled.mounted.unmount()
    const stable = mountNavigation(vi.fn().mockResolvedValue('a2'))
    await act(async () => { expect(await stable.actions.focusAgentBySessionId('a2')).toBe(true) })
    expect(stable.getState()).toEqual(expected)
    stable.mounted.unmount()
  })

  it('does not replace a different lane after focus moves while waking', async () => {
    // A wake can take seconds. "Fill the focused lane" is meaningful only for
    // the lane that was focused when navigation began; if the user moves focus
    // during the wake, the newly focused lane must not be silently repurposed.
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const harness = mountNavigation(vi.fn(() => gate))
    const navigation = harness.actions.focusAgentBySessionId('a2')
    harness.setState(current => ({
      ...current,
      dispatchMode: { ...current.dispatchMode!, tiled: { ...current.dispatchMode!.tiled!, focusedLane: 0 } },
    }))
    await act(async () => { finish(); expect(await navigation).toBe(false) })
    expect(laneIds(harness.getState())).toEqual(['a1', null])
    expect(harness.getState().dispatchMode?.tiled?.focusedLane).toBe(0)
    harness.mounted.unmount()
  })

  it('wakes a parked target before placing it in the focused lane', async () => {
    const ensureSessionLive = vi.fn().mockResolvedValue('a2')
    const harness = mountNavigation(ensureSessionLive)

    await act(async () => {
      expect(await harness.actions.focusAgentByPaneLabel('a2')).toBe(true)
    })

    expect(ensureSessionLive).toHaveBeenCalledWith('a2', 'agent-index.navigate')
    expect(laneIds(harness.getState())).toEqual(['a1', 'a2'])
    // Placement never changes pool membership: a2 is still the same parked
    // record, now shown in a lane.
    expect(harness.getState().detachedSessions.a2?.sessionId).toBe('a2')
    expect(harness.showToast).not.toHaveBeenCalled()
    harness.mounted.unmount()
  })

  it('threads the bang intent through wake and commit into the focused lane', async () => {
    const state = makeState()
    state.dispatchMode = {
      scope: 'global',
      focusedSessionId: 'a1',
      tiled: {
        focusedLane: 0,
        lanes: [
          { selectedSessionId: 'a1' },
          { selectedSessionId: 'a2' },
        ],
      },
    }
    const ensureSessionLive = vi.fn().mockResolvedValue('a2')
    const harness = mountNavigation(ensureSessionLive, state)

    await act(async () => {
      expect(await harness.actions.focusAgentByPaneLabel(
        'A2',
        'open-in-focused-tiled-dispatch-lane',
      )).toBe(true)
    })

    expect(ensureSessionLive).toHaveBeenCalledWith('a2', 'agent-index.navigate')
    expect(harness.getState().dispatchMode?.tiled).toMatchObject({
      focusedLane: 0,
      lanes: [
        { selectedSessionId: 'a2' },
        { selectedSessionId: 'a2' },
      ],
    })
    harness.mounted.unmount()
  })

  it('keeps the stage unchanged when a hibernated target cannot be woken', async () => {
    const ensureSessionLive = vi.fn().mockRejectedValue(new Error('provider unavailable'))
    const harness = mountNavigation(ensureSessionLive)

    await act(async () => {
      expect(await harness.actions.focusAgentByPaneLabel('A2')).toBe(false)
    })

    expect(laneIds(harness.getState())).toEqual(['a1', null])
    expect(harness.getState().detachedSessions.a2?.sessionId).toBe('a2')
    expect(harness.showToast).toHaveBeenCalledWith('provider unavailable')
    harness.mounted.unmount()
  })
})
