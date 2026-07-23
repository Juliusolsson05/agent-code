import { act } from 'react'
import type { MutableRefObject } from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { UndoCloseStack } from '@renderer/lib/undoClose'
import { useAgentIndexNavigationActions } from '@renderer/workspace/hook/actions/agentIndexNavigation'
import type { SessionActions } from '@renderer/workspace/hook/actions/session'
import type {
  WorkspaceSetState,
  WorkspaceSetTileTabs,
} from '@renderer/workspace/hook/context'
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
    dispatchMode: null,
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
    latestTileTabsRef: ref(null),
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
    saveTimerRef: ref(null),
    bootRef: ref(false),
  }
}

function mountNavigation(ensureSessionLive: ReturnType<typeof vi.fn>) {
  const refs = makeRefs(makeState())
  let state = refs.stateRef.current
  const setState: WorkspaceSetState = next => {
    state = typeof next === 'function' ? next(state) : next
    refs.stateRef.current = state
    refs.latestStateRef.current = state
  }
  const setTileTabs: WorkspaceSetTileTabs = next => {
    const current = refs.latestTileTabsRef.current
    refs.latestTileTabsRef.current = typeof next === 'function' ? next(current) : next
  }
  const showToast = vi.fn()
  let actions!: ReturnType<typeof useAgentIndexNavigationActions>

  function Harness(): React.JSX.Element {
    actions = useAgentIndexNavigationActions(
      setState,
      setTileTabs,
      refs,
      { ensureSessionLive } as unknown as SessionActions,
      showToast,
    )
    return <div />
  }

  const mounted = render(<Harness />)
  return { actions, mounted, showToast, getState: () => state }
}

describe('useAgentIndexNavigationActions', () => {
  it('wakes a detached target before swapping it into the focused grid slot', async () => {
    const ensureSessionLive = vi.fn().mockResolvedValue('a2')
    const harness = mountNavigation(ensureSessionLive)

    await act(async () => {
      expect(await harness.actions.focusAgentByPaneLabel('a2')).toBe(true)
    })

    expect(ensureSessionLive).toHaveBeenCalledWith('a2')
    expect(harness.getState().tabs[0].root).toEqual({ type: 'leaf', sessionId: 'a2' })
    expect(harness.getState().detachedSessions.a1?.sessionId).toBe('a1')
    expect(harness.getState().detachedSessions.a2).toBeUndefined()
    expect(harness.showToast).not.toHaveBeenCalled()
    harness.mounted.unmount()
  })

  it('keeps layout unchanged when a hibernated target cannot be woken', async () => {
    const ensureSessionLive = vi.fn().mockRejectedValue(new Error('provider unavailable'))
    const harness = mountNavigation(ensureSessionLive)

    await act(async () => {
      expect(await harness.actions.focusAgentByPaneLabel('A2')).toBe(false)
    })

    expect(harness.getState().tabs[0].root).toEqual({ type: 'leaf', sessionId: 'a1' })
    expect(harness.getState().detachedSessions.a2?.sessionId).toBe('a2')
    expect(harness.showToast).toHaveBeenCalledWith('provider unavailable')
    harness.mounted.unmount()
  })
})
