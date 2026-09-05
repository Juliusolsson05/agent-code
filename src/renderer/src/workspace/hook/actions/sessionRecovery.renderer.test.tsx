import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MutableRefObject } from 'react'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'

import { killSessionBackendIfOwned, useSessionActions } from './session'

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
  it('uses the captured spawn scope for cleanup before render refs catch up', async () => {
    const killOwnedSession = vi.fn(async () => true)
    Object.defineProperty(window, 'api', { configurable: true, value: { killOwnedSession } })
    const refs = { stateRef: ref({ sessions: {} }) } as unknown as WorkspaceRefs
    expect(await killSessionBackendIfOwned(refs, 'just-spawned')).toBe(false)
    expect(killOwnedSession).not.toHaveBeenCalled()
    expect(await killSessionBackendIfOwned(refs, 'just-spawned', { cwd: '/captured/project', kind: 'codex' })).toBe(true)
    expect(killOwnedSession).toHaveBeenCalledExactlyOnceWith({ sessionId: 'just-spawned', cwd: '/captured/project', kind: 'codex', providerRuntime: undefined })
  })

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
      .mockResolvedValueOnce({
        sessionId: 'opencode-terminal',
        providerSessionId: 'ses_precreated_at_runtime_start',
      })
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
      await result.current.spawn('/tmp/project', {
        kind: 'opencode',
        providerRuntime: 'terminal',
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
    expect(spawnSession).toHaveBeenNthCalledWith(3, expect.objectContaining({
      kind: 'opencode',
      providerRuntime: 'terminal',
      builtInMcpDomains: ['orchestration', 'workflows'],
    }))
    expect(state.sessions['claude-default']?.builtInMcpDomains).toEqual(['orchestration'])
    expect(state.sessions['codex-explicit-off']?.builtInMcpDomains).toEqual([])
    expect(state.sessions['opencode-terminal']).toMatchObject({
      kind: 'opencode',
      providerRuntime: 'terminal',
      providerSessionId: 'ses_precreated_at_runtime_start',
      providerSessionIdSource: 'runtime-start',
    })
    // Native terminal sessions intentionally skip structured history loading;
    // the provider's durable identity is for recovery and conversion, not an
    // instruction to mount the immature rendered OpenCode surface.
    expect(runtimes['opencode-terminal']).toMatchObject({
      transcriptStatus: 'ready',
      processStatus: 'started',
      hasOlderHistory: false,
    })
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
        sessionRunId: '44444444-4444-4444-8444-444444444444',
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
        sessionRunId: '55555555-5555-4555-8555-555555555555',
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
      sessionRunId: '55555555-5555-4555-8555-555555555555',
      processStatus: 'started',
      processError: null,
      recoveryFailureCode: null,
      inputReady: true,
      inputReadinessRevision: 7,
      exited: null,
    })
  })

  // #772: a readiness deadline must never kill a backend that is alive but
  // slow to boot; only an observed exit or start failure may.
  function spawnedNotReadyHarness(sessionId: string, providerRuntime?: 'terminal') {
    let state = {
      tabs: [{
        id: 'tab-1',
        title: 'Project',
        focusedSessionId: sessionId,
        root: { type: 'leaf' as const, sessionId },
      }],
      activeTabId: 'tab-1',
      sessions: {
        [sessionId]: {
          cwd: '/tmp/project',
          kind: (providerRuntime ? 'opencode' : 'claude') as 'opencode' | 'claude',
          ...(providerRuntime ? { providerRuntime } : {}),
        },
      },
      detachedSessions: {},
      buried: [],
      pinnedSessionIds: [],
      dispatchMode: null,
    } as WorkspaceState
    let runtimes: Record<SessionId, SessionRuntime> = {
      [sessionId]: { ...emptyRuntime(), processStatus: 'spawning', inputReady: false },
    }
    const refs = {
      stateRef: ref(state),
      latestStateRef: ref(state),
      latestRuntimesRef: ref(runtimes),
      dangerousAgentsRef: ref(false),
      useProxyStreamingRef: ref(false),
      defaultBuiltInMcpDomainsRef: ref([]),
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
      disposition: 'spawned' as const,
      snapshot: {
        sessionId,
        sessionRunId: '66666666-6666-4666-8666-666666666666',
        kind: (providerRuntime ? 'opencode' : 'claude') as 'opencode' | 'claude',
        ...(providerRuntime ? { providerRuntime } : {}),
        cwd: '/tmp/project',
        lifecycle: 'live' as const,
        input: { ready: false, revision: 1, reason: 'starting' as const },
        builtInMcpDomains: [],
      },
    }))
    const killOwnedSession = vi.fn(async () => true)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { recoverSession, killOwnedSession, ghostRead: vi.fn(async () => []) },
    })
    const { result } = renderHook(() => useSessionActions(state, setState, setRuntimes, refs))
    return { result, recoverSession, killOwnedSession, runtimes: () => runtimes, setRuntimes }
  }

  it('does not kill a spawned backend that is alive but not ready when the deadline passes', async () => {
    vi.useFakeTimers()
    try {
      const sessionId = 'slow-boot'
      const h = spawnedNotReadyHarness(sessionId)
      let wake: Promise<unknown> | undefined
      await act(async () => {
        wake = h.result.current.ensureSessionLive(sessionId, 'tile-leaf.send')
        await vi.advanceTimersByTimeAsync(31_000)
      })
      await expect(wake).resolves.toMatchObject({ sessionId })
      expect(h.killOwnedSession).not.toHaveBeenCalled()
      expect(h.runtimes()[sessionId]).toMatchObject({ processStatus: 'started', inputReady: false, exited: null })
    } finally {
      vi.useRealTimers()
    }
  })

  it('still fails the wake when the backend exits before it is ready', async () => {
    vi.useFakeTimers()
    try {
      const sessionId = 'dies-early'
      const h = spawnedNotReadyHarness(sessionId)
      let wake: Promise<unknown> | undefined
      await act(async () => {
        wake = h.result.current.ensureSessionLive(sessionId, 'tile-leaf.send')
        wake.catch(() => undefined)
        await vi.advanceTimersByTimeAsync(100)
        h.setRuntimes(prev => ({ ...prev, [sessionId]: { ...prev[sessionId]!, exited: 1 } }))
        await vi.advanceTimersByTimeAsync(100)
      })
      await expect(wake).rejects.toThrow(/exited/)
      expect(h.killOwnedSession).toHaveBeenCalledTimes(1)
      expect(h.runtimes()[sessionId]?.processStatus).toBe('failed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips the readiness wait for the terminal runtime and for callers that opt out', async () => {
    const terminal = spawnedNotReadyHarness('tui-pane', 'terminal')
    await act(async () => {
      await expect(terminal.result.current.ensureSessionLive('tui-pane', 'tile-leaf.send')).resolves.toMatchObject({ sessionId: 'tui-pane' })
    })
    expect(terminal.killOwnedSession).not.toHaveBeenCalled()

    const optOut = spawnedNotReadyHarness('raw-pane')
    await act(async () => {
      await expect(
        optOut.result.current.ensureSessionLive('raw-pane', 'agent-terminal-leaf.attach-retry', { awaitInputReady: false }),
      ).resolves.toMatchObject({ sessionId: 'raw-pane' })
    })
    expect(optOut.killOwnedSession).not.toHaveBeenCalled()
  })

  it('carries the latest pane title across a delayed session replacement', async () => {
    const sessionId = 'source-session'
    let state = {
      tabs: [{
        id: 'tab-1',
        title: 'Project',
        focusedSessionId: sessionId,
        root: { type: 'leaf' as const, sessionId },
      }],
      activeTabId: 'tab-1',
      sessions: {
        [sessionId]: {
          cwd: '/tmp/project',
          kind: 'claude' as const,
          title: 'Initial title',
        },
      },
      detachedSessions: {},
      gridRelatedSelections: {},
      buried: [],
      pinnedSessionIds: [],
      dispatchMode: null,
    } as WorkspaceState
    let runtimes: Record<SessionId, SessionRuntime> = {
      [sessionId]: emptyRuntime(),
    }
    const refs = {
      stateRef: ref(state),
      latestStateRef: ref(state),
      latestRuntimesRef: ref(runtimes),
      dangerousAgentsRef: ref(false),
      useProxyStreamingRef: ref(false),
      defaultBuiltInMcpDomainsRef: ref([]),
      seenUuidsRef: ref({}),
      latestScreenRef: ref({}),
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
    let finishSpawn!: (value: { sessionId: string }) => void
    const spawnSession = vi.fn(() => new Promise<{ sessionId: string }>(resolve => {
      finishSpawn = resolve
    }))
    const ghostRead = vi.fn(async () => [])
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        spawnSession,
        killOwnedSession: vi.fn(async () => true),
        ghostRead,
      },
    })
    const { result } = renderHook(() => useSessionActions(
      state,
      setState,
      setRuntimes,
      refs,
    ))

    let replacement!: Promise<SessionId | undefined>
    act(() => {
      replacement = result.current.replaceSession('/tmp/project', {
        kind: 'codex',
        targetSessionId: sessionId,
      })
    })
    act(() => {
      // WHY edit while spawn is unresolved: provider switches and rewinds can
      // wait on backend work. Reading the pre-await snapshot would make a Save
      // that visibly succeeded disappear when that delayed replacement lands.
      setState(prev => ({
        ...prev,
        sessions: {
          ...prev.sessions,
          [sessionId]: { ...prev.sessions[sessionId]!, title: 'Edited during switch' },
        },
      }))
    })
    await act(async () => {
      finishSpawn({ sessionId: 'replacement-session' })
      await replacement
    })

    expect(state.sessions[sessionId]).toBeUndefined()
    expect(state.sessions['replacement-session']?.title).toBe('Edited during switch')
    // `spawn` intentionally defers ghost bootstrap by one timer tick. Let that
    // owned task finish before afterEach removes the API mock, or this test can
    // leak an irrelevant unhandled rejection into a later full-suite worker.
    await vi.waitFor(() => expect(ghostRead).toHaveBeenCalledWith('replacement-session'))
  })
})
