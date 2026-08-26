import { act, renderHook } from '@testing-library/react'
import type { MutableRefObject } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { UndoCloseStack } from '@renderer/lib/undoClose'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'

import { useSessionActions } from './session'

vi.mock('@renderer/workspace/hook/actions/initialHistory', () => ({
  loadInitialHistoryForSession: vi.fn(async () => undefined),
}))

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')

afterEach(() => {
  vi.useRealTimers()
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

function ref<T>(current: T): MutableRefObject<T> {
  return { current }
}

describe('renderer session replacement handoff', () => {
  it('names the local predecessor only on the central replaceSession spawn', async () => {
    vi.useFakeTimers()
    const predecessorId = 'local-predecessor'
    let state = {
      tabs: [{
        id: 'tab-a',
        title: 'recorded',
        root: { type: 'leaf' as const, sessionId: predecessorId },
        focusedSessionId: predecessorId,
      }],
      activeTabId: 'tab-a',
      sessions: {
        [predecessorId]: {
          cwd: '/recorded/worktree',
          kind: 'codex' as const,
          providerSessionId: 'recorded-provider-session',
          providerSessionIdSource: 'resume-request' as const,
          builtInMcpDomains: [],
        },
      },
      detachedSessions: {},
      buried: [],
      pinnedSessionIds: [],
      dispatchMode: null,
    } as WorkspaceState
    let runtimes: Record<SessionId, SessionRuntime> = {
      [predecessorId]: {
        ...emptyRuntime(),
        draftInput: 'keep this draft',
      },
    }
    const refs = {
      stateRef: ref(state),
      latestStateRef: ref(state),
      latestRuntimesRef: ref(runtimes),
      latestTileTabsRef: ref(null),
      dangerousAgentsRef: ref(false),
      useProxyStreamingRef: ref(true),
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
    } as WorkspaceRefs
    const setState = (
      next: WorkspaceState | ((previous: WorkspaceState) => WorkspaceState),
    ): void => {
      state = typeof next === 'function' ? next(state) : next
      refs.stateRef.current = state
      refs.latestStateRef.current = state
    }
    const setRuntimes = (
      next: Record<SessionId, SessionRuntime> |
        ((previous: Record<SessionId, SessionRuntime>) => Record<SessionId, SessionRuntime>),
    ): void => {
      runtimes = typeof next === 'function' ? next(runtimes) : next
      refs.latestRuntimesRef.current = runtimes
    }
    const spawnSession = vi.fn()
      .mockResolvedValueOnce({ sessionId: 'local-successor' })
      .mockResolvedValueOnce({ sessionId: 'fresh-local-session' })
    const killOwnedSession = vi.fn(async () => false)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        spawnSession,
        killOwnedSession,
        ghostRead: vi.fn(async () => []),
      },
    })

    const { result } = renderHook(() => useSessionActions(
      {
        activeTabId: state.activeTabId,
        sessions: state.sessions,
        tabs: state.tabs,
      },
      setState,
      setRuntimes,
      refs,
    ))

    await act(async () => {
      await result.current.replaceSession('/recorded/worktree', {
        kind: 'codex',
        resumeSessionId: 'recorded-provider-session',
        builtInMcpDomains: ['workflows'],
      })
      await vi.runAllTimersAsync()
    })

    expect(spawnSession).toHaveBeenCalledWith({
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: 'recorded-provider-session',
      predecessorSessionId: predecessorId,
      dangerousMode: false,
      useProxy: true,
      recoverTmuxName: undefined,
      builtInMcpDomains: ['workflows'],
    })
    // Main already consumed the authorized handoff in production. The existing
    // renderer cleanup remains a generation-safe no-op fallback and must still
    // carry its durable owner tuple rather than issuing an id-only kill.
    expect(killOwnedSession).toHaveBeenCalledWith({
      sessionId: predecessorId,
      kind: 'codex',
      cwd: '/recorded/worktree',
    })
    expect(state.tabs[0]).toMatchObject({
      root: { type: 'leaf', sessionId: 'local-successor' },
      focusedSessionId: 'local-successor',
    })
    expect(runtimes['local-successor']?.draftInput).toBe('keep this draft')

    await act(async () => {
      await result.current.spawn('/recorded/worktree', { kind: 'codex' })
      await vi.runAllTimersAsync()
    })
    expect(spawnSession).toHaveBeenNthCalledWith(2, {
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: undefined,
      dangerousMode: false,
      useProxy: true,
      recoverTmuxName: undefined,
      builtInMcpDomains: [],
    })
  })
})
