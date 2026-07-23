import { EventEmitter } from 'node:events'
import type { MutableRefObject } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { PersistedWorkspace } from '@renderer/workspace/persistence'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'

const { createSession, loadInitialHistoryForSession } = vi.hoisted(() => ({
  createSession: vi.fn(),
  loadInitialHistoryForSession: vi.fn(),
}))

vi.mock('@providers/registry.main.js', () => ({
  getMainProvider: () => ({ createSession }),
}))

vi.mock('@main/setup/toolchain.js', () => ({
  getToolPath: () => '/usr/bin/true',
}))

vi.mock('@main/performance/PerformanceService.js', () => ({
  performanceService: {
    mark: vi.fn(),
    record: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@main/storage/feedDebugLog.js', () => ({
  forgetFeedDebugSession: vi.fn(),
}))

vi.mock('@renderer/performance/client', () => ({
  mark: vi.fn(),
  span: () => ({ end: vi.fn(), fail: vi.fn() }),
}))

vi.mock('@renderer/workspace/hook/actions/initialHistory', () => ({
  loadInitialHistoryForSession,
}))

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

class FakeAgentSession extends EventEmitter {
  readonly stop = vi.fn(async (): Promise<void> => {})
  readonly write = vi.fn()
  readonly resize = vi.fn()

  constructor(private readonly options: {
    ready?: boolean
    startGate?: Promise<void>
    startError?: Error
  } = {}) {
    super()
  }

  async start(): Promise<void> {
    await this.options.startGate
    if (this.options.startError) throw this.options.startError
    this.emit('started', { projectDir: '/tmp/project' })
    if (this.options.ready === true) {
      this.emit('input-readiness', { ready: true, reason: 'ready' })
    }
  }
}

function ref<T>(current: T): MutableRefObject<T> {
  return { current }
}

function makePersisted(): PersistedWorkspace {
  return {
    tabs: [{
      id: 'tab-1',
      title: 'Project',
      focusedSessionId: 'stable-session',
      root: { type: 'leaf', sessionId: 'stable-session' },
    }],
    activeTabId: 'tab-1',
    sessions: {
      'stable-session': {
        cwd: '/tmp/project',
        kind: 'codex',
        providerSessionId: 'provider-history',
        providerSessionIdSource: 'resume-request',
        builtInMcpDomains: ['workflows'],
      },
    },
    drafts: { 'stable-session': 'unfinished prompt' },
    pinnedSessionIds: ['stable-session'],
  }
}

function makeRendererHarness() {
  let state = {
    tabs: [],
    activeTabId: 'tab-1',
    sessions: {},
    detachedSessions: {},
    buried: [],
    pinnedSessionIds: [],
    dispatchMode: null,
  } as unknown as WorkspaceState
  let runtimes: Record<SessionId, SessionRuntime> = {}
  let tileTabs: unknown = null
  const refs = {
    dangerousAgentsRef: ref(false),
    useProxyStreamingRef: ref(false),
    defaultBuiltInMcpDomainsRef: ref([]),
    stateRef: ref(state),
    latestStateRef: ref(state),
    latestRuntimesRef: ref(runtimes),
  } as unknown as WorkspaceRefs

  return {
    refs,
    state: () => state,
    runtimes: () => runtimes,
    setState: (next: WorkspaceState | ((prev: WorkspaceState) => WorkspaceState)) => {
      state = typeof next === 'function' ? next(state) : next
      refs.stateRef.current = state
      refs.latestStateRef.current = state
    },
    setRuntimes: (
      next:
        | Record<SessionId, SessionRuntime>
        | ((prev: Record<SessionId, SessionRuntime>) => Record<SessionId, SessionRuntime>),
    ) => {
      runtimes = typeof next === 'function' ? next(runtimes) : next
      refs.latestRuntimesRef.current = runtimes
    },
    setTileTabs: (next: unknown) => {
      tileTabs = typeof next === 'function'
        ? (next as (prev: unknown) => unknown)(tileTabs)
        : next
    },
  }
}

describe('cross-layer session restart reconciliation', () => {
  beforeEach(() => {
    createSession.mockReset()
    loadInitialHistoryForSession.mockReset()
  })

  it('cold-starts once, adopts on renderer reload, and preserves identity and readiness', async () => {
    const { SessionManager } = await import('@main/sessionManager')
    const { rehydrateWorkspace } = await import(
      '@renderer/workspace/hook/persistence/rehydrate'
    )
    const firstProvider = new FakeAgentSession({ ready: true })
    const replacementProvider = new FakeAgentSession()
    createSession
      .mockImplementationOnce(() => firstProvider)
      .mockImplementationOnce(() => replacementProvider)
    const registerSession = vi.fn(() => [])
    const revokeSession = vi.fn()
    const sessionDomains = vi.fn(() => ['workflows'])
    const manager = new SessionManager(null, {
      registerSession,
      revokeSession,
      // This cross-layer harness mocks transport setup, so it must also expose
      // the effective authorization fact a real BuiltInMcpHttpHost retains.
      sessionDomains,
    } as never)
    const persisted = makePersisted()
    const recoveryApi = {
      recoverSession: manager.recover.bind(manager),
      cancelSessionRecovery: manager.cancelRecovery.bind(manager),
      defaultCwd: vi.fn(async () => '/tmp/fallback'),
    }

    const firstRenderer = makeRendererHarness()
    const firstResult = await rehydrateWorkspace(
      persisted,
      firstRenderer.refs,
      firstRenderer.setState,
      firstRenderer.setRuntimes,
      firstRenderer.setTileTabs,
      vi.fn(),
      recoveryApi,
    )
    const reloadedRenderer = makeRendererHarness()
    const reloadResult = await rehydrateWorkspace(
      persisted,
      reloadedRenderer.refs,
      reloadedRenderer.setState,
      reloadedRenderer.setRuntimes,
      reloadedRenderer.setTileTabs,
      vi.fn(),
      recoveryApi,
    )

    expect(firstResult).toEqual({ restoredSessions: 1, expectedSessions: 1, complete: true })
    expect(reloadResult).toEqual({ restoredSessions: 1, expectedSessions: 1, complete: true })
    expect(createSession).toHaveBeenCalledTimes(1)
    expect(registerSession).toHaveBeenCalledTimes(1)
    expect(registerSession).toHaveBeenCalledWith({
      sessionId: 'stable-session',
      cwd: '/tmp/project',
      providerKind: 'codex',
      domains: ['workflows'],
    })
    expect(createSession.mock.calls[0]?.[0]).toMatchObject({
      cwd: '/tmp/project',
      resumeSessionId: 'provider-history',
      shellSessionId: 'stable-session',
    })
    expect(reloadedRenderer.state()).toMatchObject({
      activeTabId: 'tab-1',
      pinnedSessionIds: ['stable-session'],
      sessions: {
        'stable-session': {
          providerSessionId: 'provider-history',
          builtInMcpDomains: ['workflows'],
        },
      },
    })
    expect(reloadedRenderer.state().tabs[0].root).toEqual({
      type: 'leaf',
      sessionId: 'stable-session',
    })
    expect(reloadedRenderer.runtimes()['stable-session']).toMatchObject({
      draftInput: 'unfinished prompt',
      processStatus: 'started',
      inputReady: true,
      inputReadinessRevision: 2,
    })

    await expect(manager.kill('stable-session')).resolves.toBe(true)
    const restartedRenderer = makeRendererHarness()
    await rehydrateWorkspace(
      persisted,
      restartedRenderer.refs,
      restartedRenderer.setState,
      restartedRenderer.setRuntimes,
      restartedRenderer.setTileTabs,
      vi.fn(),
      recoveryApi,
    )

    expect(createSession).toHaveBeenCalledTimes(2)
    expect(registerSession).toHaveBeenCalledTimes(2)
    expect(revokeSession).toHaveBeenCalledTimes(1)
    expect(manager.list()).toEqual(['stable-session'])
    expect(restartedRenderer.runtimes()['stable-session']).toMatchObject({
      inputReady: false,
      inputReadinessRevision: 3,
    })
    await manager.killAll()
  })

  it('retains a failed pane and allows the same stable id to retry successfully', async () => {
    const { SessionManager } = await import('@main/sessionManager')
    const { rehydrateWorkspace } = await import(
      '@renderer/workspace/hook/persistence/rehydrate'
    )
    createSession
      .mockImplementationOnce(() => new FakeAgentSession({
        startError: new Error('provider unavailable'),
      }))
      .mockImplementationOnce(() => new FakeAgentSession({ ready: true }))
    const registerSession = vi.fn(() => [])
    const revokeSession = vi.fn()
    const manager = new SessionManager(null, { registerSession, revokeSession } as never)
    const persisted = makePersisted()
    const recoveryApi = {
      recoverSession: manager.recover.bind(manager),
      cancelSessionRecovery: manager.cancelRecovery.bind(manager),
      defaultCwd: vi.fn(async () => '/tmp/fallback'),
    }
    const failedRenderer = makeRendererHarness()

    const failed = await rehydrateWorkspace(
      persisted,
      failedRenderer.refs,
      failedRenderer.setState,
      failedRenderer.setRuntimes,
      failedRenderer.setTileTabs,
      vi.fn(),
      recoveryApi,
    )

    expect(failed).toEqual({ restoredSessions: 0, expectedSessions: 1, complete: true })
    expect(failedRenderer.state().tabs[0].root).toEqual({
      type: 'leaf',
      sessionId: 'stable-session',
    })
    expect(failedRenderer.runtimes()['stable-session']).toMatchObject({
      draftInput: 'unfinished prompt',
      processStatus: 'failed',
      processError: 'Session failed to start. Check provider setup and retry.',
      recoveryFailureCode: 'start-failed',
      inputReady: false,
    })
    expect(manager.getBackendSnapshot('stable-session')).toBeNull()

    const retryRenderer = makeRendererHarness()
    const retried = await rehydrateWorkspace(
      persisted,
      retryRenderer.refs,
      retryRenderer.setState,
      retryRenderer.setRuntimes,
      retryRenderer.setTileTabs,
      vi.fn(),
      recoveryApi,
    )

    expect(retried).toEqual({ restoredSessions: 1, expectedSessions: 1, complete: true })
    expect(createSession).toHaveBeenCalledTimes(2)
    expect(registerSession).toHaveBeenCalledTimes(2)
    expect(revokeSession).toHaveBeenCalledTimes(1)
    expect(retryRenderer.runtimes()['stable-session']).toMatchObject({
      processStatus: 'started',
      processError: null,
      inputReady: true,
    })
    await manager.killAll()
  })

  it('lets close cancel blocked startup without resurrecting an orphan backend', async () => {
    const { SessionManager } = await import('@main/sessionManager')
    const { rehydrateWorkspace } = await import(
      '@renderer/workspace/hook/persistence/rehydrate'
    )
    const startGate = deferred<void>()
    const blockedProvider = new FakeAgentSession({ startGate: startGate.promise })
    createSession.mockImplementationOnce(() => blockedProvider)
    const registerSession = vi.fn(() => [])
    const revokeSession = vi.fn()
    const manager = new SessionManager(null, { registerSession, revokeSession } as never)
    const persisted = makePersisted()
    const renderer = makeRendererHarness()
    const recoveryApi = {
      recoverSession: manager.recover.bind(manager),
      cancelSessionRecovery: manager.cancelRecovery.bind(manager),
      defaultCwd: vi.fn(async () => '/tmp/fallback'),
    }

    const bootstrap = rehydrateWorkspace(
      persisted,
      renderer.refs,
      renderer.setState,
      renderer.setRuntimes,
      renderer.setTileTabs,
      vi.fn(),
      recoveryApi,
    )
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1))
    await expect(manager.kill('stable-session')).resolves.toBe(true)
    startGate.resolve()
    await expect(bootstrap).resolves.toEqual({
      restoredSessions: 0,
      expectedSessions: 1,
      complete: true,
    })

    expect(blockedProvider.stop).toHaveBeenCalledTimes(2)
    expect(revokeSession).toHaveBeenCalledTimes(1)
    expect(manager.getBackendSnapshot('stable-session')).toBeNull()
    expect(manager.list()).toEqual([])
    expect(renderer.state().tabs[0].root).toEqual({
      type: 'leaf',
      sessionId: 'stable-session',
    })
    expect(renderer.runtimes()['stable-session']).toMatchObject({
      processStatus: 'failed',
      processError: expect.stringContaining('cancelled'),
      inputReady: false,
    })
  })
})
