import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MutableRefObject } from 'react'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'

import { useSessionActions } from './session'

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

describe('useSessionActions recovery retry', () => {
  it('seeds fresh sessions from Settings while an explicit empty list wins', async () => {
    let state = {
      tabs: [],
      activeTabId: '',
      sessions: {},
      detachedSessions: {},
      buried: [],
      pinnedSessionIds: [],
      dispatchMode: null,
    } as unknown as WorkspaceState
    let runtimes: Record<SessionId, SessionRuntime> = {}
    const refs = {
      stateRef: ref(state),
      latestStateRef: ref(state),
      latestRuntimesRef: ref(runtimes),
      dangerousAgentsRef: ref(false),
      useProxyStreamingRef: ref(false),
      defaultBuiltInMcpDomainsRef: ref(['orchestration', 'workflows']),
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
    const spawnSession = vi.fn()
      .mockResolvedValueOnce({ sessionId: 'claude-default' })
      .mockResolvedValueOnce({ sessionId: 'codex-explicit-off' })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { spawnSession, ghostRead: vi.fn(async () => []) },
    })
    const { result } = renderHook(() => useSessionActions(
      state,
      setState,
      setRuntimes,
      refs,
    ))

    await act(async () => {
      await result.current.spawn('/tmp/project', { kind: 'claude' })
      await result.current.spawn('/tmp/project', {
        kind: 'codex',
        builtInMcpDomains: [],
      })
    })

    expect(spawnSession).toHaveBeenNthCalledWith(1, expect.objectContaining({
      kind: 'claude',
      builtInMcpDomains: ['orchestration'],
    }))
    expect(spawnSession).toHaveBeenNthCalledWith(2, expect.objectContaining({
      kind: 'codex',
      builtInMcpDomains: [],
    }))
    expect(state.sessions['claude-default']?.builtInMcpDomains).toEqual(['orchestration'])
    expect(state.sessions['codex-explicit-off']?.builtInMcpDomains).toEqual([])
  })

  it('clears a retained failure and accepts equal-revision readiness and backend MCP facts', async () => {
    const sessionId = 'retry-session'
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
        processError: 'old failed attempt',
        recoveryFailureCode: 'start-failed',
        inputReady: false,
        inputReadinessRevision: 7,
        exited: 1,
      },
    }
    const refs = {
      stateRef: ref(state),
      latestStateRef: ref(state),
      latestRuntimesRef: ref(runtimes),
      dangerousAgentsRef: ref(false),
      useProxyStreamingRef: ref(false),
      defaultBuiltInMcpDomainsRef: ref(['orchestration', 'workflows']),
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
    const recoverSession = vi.fn(async () => ({
      ok: true as const,
      disposition: 'adopted' as const,
      snapshot: {
        sessionId,
        kind: 'claude' as const,
        cwd: '/tmp/project',
        lifecycle: 'live' as const,
        // Equal is intentional. The snapshot is a level fact, not an edge;
        // retry must restore its readiness even when the renderer already saw
        // this revision number on the abandoned generation.
        input: { ready: true, revision: 7, reason: 'ready' as const },
        // Main adopted a process launched without MCP. The request below still
        // carries current defaults, but it cannot retrofit that live process.
        builtInMcpDomains: [],
      },
    }))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { recoverSession, ghostRead: vi.fn(async () => []) },
    })

    const { result } = renderHook(() => useSessionActions(
      state,
      setState,
      setRuntimes,
      refs,
    ))

    let wakeResult: Awaited<ReturnType<typeof result.current.ensureSessionLive>> | undefined
    await act(async () => {
      wakeResult = await result.current.ensureSessionLive(sessionId, 'tile-leaf.send')
    })

    expect(recoverSession).toHaveBeenCalledTimes(1)
    expect(recoverSession).toHaveBeenCalledWith(expect.objectContaining({
      builtInMcpDomains: ['orchestration'],
    }))
    expect(state.sessions[sessionId]?.builtInMcpDomains).toEqual([])
    expect(wakeResult).toEqual({ sessionId, builtInMcpDomains: [] })
    expect(runtimes[sessionId]).toMatchObject({
      processStatus: 'started',
      processError: null,
      recoveryFailureCode: null,
      inputReady: true,
      inputReadinessRevision: 7,
      exited: null,
    })
  })
})
