import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MutableRefObject } from 'react'

import { UndoCloseStack } from '@renderer/lib/undoClose'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionActions } from '@renderer/workspace/hook/actions/session'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'

import { usePaneActions } from './pane'

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')

afterEach(() => {
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

function ref<T>(current: T): MutableRefObject<T> {
  return { current }
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
})
