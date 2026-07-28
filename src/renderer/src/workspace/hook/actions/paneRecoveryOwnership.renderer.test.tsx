import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MutableRefObject } from 'react'

import { UndoCloseStack } from '@renderer/lib/undoClose'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionActions } from '@renderer/workspace/hook/actions/session'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'
import {
  __resetCloseConfirmationForTests,
  currentCloseConfirmation,
  resolveCloseConfirmation,
} from '@renderer/workspace/closeConfirmationBroker'

import { usePaneActions } from './pane'

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')

afterEach(() => {
  __resetCloseConfirmationForTests()
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

function ref<T>(current: T): MutableRefObject<T> {
  return { current }
}

function renderPaneActionsHarness(
  initialState: WorkspaceState,
  initialRuntimes: Record<SessionId, SessionRuntime>,
  killOwnedResult = true,
) {
  let state = initialState
  let runtimes = initialRuntimes
  const refs = {
    stateRef: ref(state),
    latestStateRef: ref(state),
    latestRuntimesRef: ref(runtimes),
    seenUuidsRef: ref<Record<SessionId, Set<string>>>({}),
    latestScreenRef: ref<Record<SessionId, string>>({}),
    undoStackRef: ref(new UndoCloseStack()),
  } as unknown as WorkspaceRefs
  const setState = (next: WorkspaceState | ((prev: WorkspaceState) => WorkspaceState)) => {
    state = typeof next === 'function' ? next(state) : next
    refs.stateRef.current = state
    refs.latestStateRef.current = state
  }
  const setRuntimes = (
    next: Record<SessionId, SessionRuntime> |
      ((prev: Record<SessionId, SessionRuntime>) => Record<SessionId, SessionRuntime>),
  ) => {
    runtimes = typeof next === 'function' ? next(runtimes) : next
    refs.latestRuntimesRef.current = runtimes
  }
  const killOwnedSession = vi.fn(async () => killOwnedResult)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { killOwnedSession },
  })
  const sessionActions = {
    killSession: vi.fn(),
  } as unknown as SessionActions
  const hook = renderHook(() => usePaneActions(
    state,
    setState,
    setRuntimes,
    vi.fn(),
    vi.fn(),
    refs,
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
    sessionActions,
  ))

  return {
    ...hook,
    refs,
    killOwnedSession,
    getState: () => state,
    getRuntimes: () => runtimes,
  }
}

describe('pane recovery ownership', () => {
  it('closes an ownership-conflict leaf without killing the unrelated main backend', async () => {
    const sessionId = 'conflicted-session'
    let state = {
      tabs: [{
        id: 'tab-1',
        title: 'Project',
        focusedSessionId: sessionId,
        root: { type: 'leaf' as const, sessionId },
      }],
      activeTabId: 'tab-1',
      sessions: {
        [sessionId]: { cwd: '/tmp/project', kind: 'claude' as const },
      },
      detachedSessions: {},
      buried: [],
      pinnedSessionIds: [],
      dispatchMode: null,
    } as WorkspaceState
    let runtimes: Record<SessionId, SessionRuntime> = {
      [sessionId]: {
        ...emptyRuntime(),
        processStatus: 'failed',
        processError: 'owned elsewhere',
        recoveryFailureCode: 'ownership-conflict',
      },
    }
    const refs = {
      stateRef: ref(state),
      latestStateRef: ref(state),
      latestRuntimesRef: ref(runtimes),
      seenUuidsRef: ref<Record<SessionId, Set<string>>>({}),
      latestScreenRef: ref<Record<SessionId, string>>({}),
      undoStackRef: ref(new UndoCloseStack()),
    } as unknown as WorkspaceRefs
    const setState = (next: WorkspaceState | ((prev: WorkspaceState) => WorkspaceState)) => {
      state = typeof next === 'function' ? next(state) : next
      refs.stateRef.current = state
      refs.latestStateRef.current = state
    }
    const setRuntimes = (
      next: Record<SessionId, SessionRuntime> |
        ((prev: Record<SessionId, SessionRuntime>) => Record<SessionId, SessionRuntime>),
    ) => {
      runtimes = typeof next === 'function' ? next(runtimes) : next
      refs.latestRuntimesRef.current = runtimes
    }
    const killOwnedSession = vi.fn(async () => false)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { killOwnedSession },
    })
    const sessionActions = {
      killSession: vi.fn(),
    } as unknown as SessionActions

    const { result } = renderHook(() => usePaneActions(
      state,
      setState,
      setRuntimes,
      vi.fn(),
      vi.fn(),
      refs,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      sessionActions,
    ))

    await act(async () => {
      await result.current.closeSession(sessionId)
    })

    // Renderer cleanup is still allowed, but the destructive request carries
    // the pane's durable owner tuple and main rejects it atomically because the
    // conflicting backend does not match. A generic id-only kill must never be
    // reachable from this path.
    expect(killOwnedSession).toHaveBeenCalledWith({
      sessionId,
      kind: 'claude',
      cwd: '/tmp/project',
    })
    expect(state.sessions[sessionId]).toBeUndefined()
    expect(state.tabs).toEqual([])
    expect(runtimes[sessionId]).toBeUndefined()
  })

  it('atomically closes detached children when their last owning pane closes', async () => {
    const paneId = 'visible-pane'
    const detachedId = 'detached-child'
    const state = {
      tabs: [{
        id: 'tab-1',
        title: 'Project',
        focusedSessionId: paneId,
        root: { type: 'leaf' as const, sessionId: paneId },
      }],
      activeTabId: 'tab-1',
      sessions: {
        [paneId]: { cwd: '/tmp/project', kind: 'claude' as const },
        [detachedId]: { cwd: '/tmp/project', kind: 'codex' as const },
      },
      detachedSessions: {
        [detachedId]: {
          sessionId: detachedId,
          surface: 'dispatch' as const,
          projectTabId: 'tab-1',
          projectTabTitle: 'Project',
          projectTabIndex: 0,
          detachedAt: 123,
        },
      },
      buried: [],
      pinnedSessionIds: [],
      dispatchMode: null,
    } as WorkspaceState
    const harness = renderPaneActionsHarness(state, {
      [paneId]: emptyRuntime(),
      [detachedId]: emptyRuntime(),
    })

    // Closing the tab's last pane also kills its detached child, so this is a
    // two-session close and the gate must ask. Answering it here is not test
    // ceremony — it is the assertion that the dialog names BOTH sessions.
    // Before the gate counted detached children, this close reported one target
    // and silently took two.
    let closing: Promise<boolean> | undefined
    await act(async () => {
      closing = harness.result.current.closeSession(paneId)
      await Promise.resolve()
    })
    expect(currentCloseConfirmation()?.request.targets.map(t => t.sessionId).sort())
      .toEqual([detachedId, paneId].sort())
    await act(async () => {
      resolveCloseConfirmation(true)
      await closing
    })

    // WHY this assertion covers more than renderer cleanup: once the final tab
    // disappears, a detached child has no valid projectTabId. The save-time
    // sanitizer is right to reject it, so the close action must first make the
    // child part of the same destructive transaction and Undo Close snapshot.
    expect(harness.killOwnedSession).toHaveBeenCalledTimes(2)
    expect(harness.killOwnedSession).toHaveBeenCalledWith({
      sessionId: detachedId,
      kind: 'codex',
      cwd: '/tmp/project',
    })
    expect(harness.getState().tabs).toEqual([])
    expect(harness.getState().sessions).toEqual({})
    expect(harness.getState().detachedSessions).toEqual({})
    expect(harness.getRuntimes()).toEqual({})

    const undoEntry = harness.refs.undoStackRef.current.pop()
    expect(undoEntry?.type).toBe('tab')
    if (undoEntry?.type === 'tab') {
      expect(undoEntry.detachedEntries).toEqual([{
        meta: state.sessions[detachedId],
        detachedAt: 123,
      }])
    }
  })

  it('moves detached children into the buried archive when bury removes their tab', () => {
    const paneId = 'visible-pane'
    const detachedId = 'detached-child'
    const state = {
      tabs: [{
        id: 'tab-1',
        title: 'Project',
        focusedSessionId: paneId,
        root: { type: 'leaf' as const, sessionId: paneId },
      }],
      activeTabId: 'tab-1',
      sessions: {
        [paneId]: { cwd: '/tmp/project', kind: 'claude' as const },
        [detachedId]: { cwd: '/tmp/project', kind: 'codex' as const },
      },
      detachedSessions: {
        [detachedId]: {
          sessionId: detachedId,
          surface: 'dispatch' as const,
          projectTabId: 'tab-1',
          projectTabTitle: 'Project',
          projectTabIndex: 0,
          detachedAt: 123,
        },
      },
      buried: [],
      pinnedSessionIds: [],
      dispatchMode: null,
    } as WorkspaceState
    const harness = renderPaneActionsHarness(state, {
      [paneId]: emptyRuntime(),
      [detachedId]: emptyRuntime(),
    })

    act(() => {
      harness.result.current.buryFocused('keep this work', paneId)
    })

    // Bury is a non-destructive visibility operation. Both sessions remain
    // live, but both acquire durable archive ownership before the tab vanishes.
    expect(harness.killOwnedSession).not.toHaveBeenCalled()
    expect(harness.getState().tabs).toEqual([])
    expect(harness.getState().detachedSessions).toEqual({})
    expect(harness.getState().buried.map(entry => entry.sessionId)).toEqual([
      paneId,
      detachedId,
    ])
    expect(harness.getState().sessions).toEqual(state.sessions)
    expect(Object.keys(harness.getRuntimes())).toEqual([paneId, detachedId])
  })
})
