import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MutableRefObject } from 'react'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { PersistedWorkspace } from '@renderer/workspace/persistence'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'

import { rehydrateWorkspace } from './rehydrate'

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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
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
        kind: 'claude',
        builtInMcpDomains: ['workflows'],
      },
    },
    drafts: { 'stable-session': 'unfinished prompt' },
    pinnedSessionIds: ['stable-session'],
  }
}

function makeHarness() {
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
  let tileTabs: null = null
  const refs = {
    dangerousAgentsRef: ref(false),
    useProxyStreamingRef: ref(false),
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
        ? (next as (prev: null) => null)(tileTabs)
        : next as null
    },
  }
}

describe('rehydrateWorkspace backend reconciliation', () => {
  it('adopts under the persisted local id without calling the fresh-spawn API', async () => {
    const persisted = makePersisted()
    const harness = makeHarness()
    const recoverSession = vi.fn(async () => ({
      ok: true as const,
      disposition: 'adopted' as const,
      snapshot: {
        sessionId: 'stable-session',
        kind: 'claude' as const,
        cwd: '/tmp/project',
        lifecycle: 'live' as const,
        input: { ready: true, revision: 4, reason: 'ready' as const },
      },
    }))
    const spawnSession = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { recoverSession, spawnSession, defaultCwd: vi.fn() },
    })

    const result = await rehydrateWorkspace(
      persisted,
      harness.refs,
      harness.setState,
      harness.setRuntimes,
      harness.setTileTabs,
      vi.fn(),
    )

    expect(result).toEqual({ restoredSessions: 1, expectedSessions: 1, complete: true })
    expect(recoverSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'stable-session',
      cwd: '/tmp/project',
      kind: 'claude',
      builtInMcpDomains: ['workflows'],
    }))
    expect(spawnSession).not.toHaveBeenCalled()
    expect(harness.state().tabs[0].root).toEqual({
      type: 'leaf',
      sessionId: 'stable-session',
    })
    expect(harness.state().pinnedSessionIds).toEqual(['stable-session'])
    expect(harness.runtimes()['stable-session']).toMatchObject({
      draftInput: 'unfinished prompt',
      processStatus: 'started',
      processError: null,
      inputReady: true,
    })
  })

  it('retains the pane, metadata, and draft when backend recovery fails', async () => {
    const persisted = makePersisted()
    const harness = makeHarness()
    const recoverSession = vi.fn(async () => ({
      ok: false as const,
      code: 'start-failed' as const,
      retryable: true,
      message: 'Claude CLI not found',
    }))
    const newTab = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        recoverSession,
        spawnSession: vi.fn(),
        defaultCwd: vi.fn(async () => '/tmp/fallback'),
      },
    })

    const result = await rehydrateWorkspace(
      persisted,
      harness.refs,
      harness.setState,
      harness.setRuntimes,
      harness.setTileTabs,
      newTab,
    )

    expect(result).toEqual({ restoredSessions: 0, expectedSessions: 1, complete: true })
    expect(newTab).not.toHaveBeenCalled()
    expect(harness.state().sessions['stable-session']).toMatchObject({
      cwd: '/tmp/project',
      kind: 'claude',
    })
    expect(harness.state().tabs[0].root).toEqual({
      type: 'leaf',
      sessionId: 'stable-session',
    })
    expect(harness.runtimes()['stable-session']).toMatchObject({
      draftInput: 'unfinished prompt',
      processStatus: 'failed',
      processError: 'Claude CLI not found',
      recoveryFailureCode: 'start-failed',
      inputReady: false,
    })
  })

  it('does not let an older recovery snapshot overwrite a newer readiness event', async () => {
    const persisted = makePersisted()
    const harness = makeHarness()
    harness.setRuntimes({
      'stable-session': {
        ...emptyRuntime(),
        processStatus: 'started',
        inputReady: true,
        inputReadinessRevision: 5,
      },
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        recoverSession: vi.fn(async () => ({
          ok: true as const,
          disposition: 'adopted' as const,
          snapshot: {
            sessionId: 'stable-session',
            kind: 'claude' as const,
            cwd: '/tmp/project',
            lifecycle: 'live' as const,
            input: { ready: false, revision: 4, reason: 'replaying-history' as const },
          },
        })),
        defaultCwd: vi.fn(),
      },
    })

    await rehydrateWorkspace(
      persisted,
      harness.refs,
      harness.setState,
      harness.setRuntimes,
      harness.setTileTabs,
      vi.fn(),
    )

    expect(harness.runtimes()['stable-session']).toMatchObject({
      inputReady: true,
      inputReadinessRevision: 5,
    })
  })

  it('keeps failed siblings in a split after every leaf has a resolved outcome', async () => {
    const persisted = makePersisted()
    persisted.sessions['second-session'] = { cwd: '/tmp/project', kind: 'codex' }
    persisted.tabs[0].root = {
      type: 'split',
      direction: 'vertical',
      ratio: 0.5,
      a: { type: 'leaf', sessionId: 'stable-session' },
      b: { type: 'leaf', sessionId: 'second-session' },
    }
    const harness = makeHarness()
    const recoverSession = vi.fn(async ({ sessionId }: { sessionId: string }) =>
      sessionId === 'stable-session'
        ? {
            ok: true as const,
            disposition: 'spawned' as const,
            snapshot: {
              sessionId,
              kind: 'claude' as const,
              cwd: '/tmp/project',
              lifecycle: 'live' as const,
              input: { ready: false, revision: 0, reason: 'starting' as const },
            },
          }
        : {
            ok: false as const,
            code: 'ownership-conflict' as const,
            retryable: false,
            message: 'Owned by another project',
          },
    )
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { recoverSession, spawnSession: vi.fn(), defaultCwd: vi.fn() },
    })

    const result = await rehydrateWorkspace(
      persisted,
      harness.refs,
      harness.setState,
      harness.setRuntimes,
      harness.setTileTabs,
      vi.fn(),
    )

    expect(result).toEqual({ restoredSessions: 1, expectedSessions: 2, complete: true })
    expect(harness.state().tabs[0].root).toMatchObject({
      type: 'split',
      a: { sessionId: 'stable-session' },
      b: { sessionId: 'second-session' },
    })
    expect(harness.runtimes()['second-session']).toMatchObject({
      processStatus: 'failed',
      processError: 'Owned by another project',
      recoveryFailureCode: 'ownership-conflict',
      inputReady: false,
    })
  })

  it('never replays persisted layout or runtime state after the initial shell is published', async () => {
    const persisted = makePersisted()
    persisted.sessions['second-session'] = {
      cwd: '/tmp/project',
      kind: 'codex',
      title: 'Persisted title',
    }
    persisted.tabs[0].root = {
      type: 'split',
      direction: 'vertical',
      ratio: 0.5,
      a: { type: 'leaf', sessionId: 'stable-session' },
      b: { type: 'leaf', sessionId: 'second-session' },
    }
    const first = deferred<Awaited<ReturnType<Window['api']['recoverSession']>>>()
    const second = deferred<Awaited<ReturnType<Window['api']['recoverSession']>>>()
    const harness = makeHarness()
    const recoveryApi = {
      recoverSession: vi.fn(({ sessionId }: { sessionId: string }) =>
        sessionId === 'stable-session' ? first.promise : second.promise,
      ),
      cancelSessionRecovery: vi.fn(async () => true),
      defaultCwd: vi.fn(async () => '/tmp/fallback'),
    }

    const bootstrap = rehydrateWorkspace(
      persisted,
      harness.refs,
      harness.setState,
      harness.setRuntimes,
      harness.setTileTabs,
      vi.fn(),
      recoveryApi,
    )

    expect(harness.state().tabs[0].root).toMatchObject({
      type: 'split',
      a: { sessionId: 'stable-session' },
      b: { sessionId: 'second-session' },
    })
    expect(harness.runtimes()['stable-session'].processStatus).toBe('spawning')
    expect(harness.runtimes()['second-session'].processStatus).toBe('spawning')

    first.resolve({
      ok: true,
      disposition: 'spawned',
      snapshot: {
        sessionId: 'stable-session',
        kind: 'claude',
        cwd: '/tmp/project',
        lifecycle: 'live',
        input: { ready: true, revision: 2, reason: 'ready' },
      },
    })
    await vi.waitFor(() => {
      expect(harness.runtimes()['stable-session'].processStatus).toBe('started')
    })

    // Model user and live-feed mutations while the second provider is still
    // unresolved. Its eventual outcome owns neither the removed first leaf nor
    // this newer draft/feed/title state.
    harness.setState(prev => ({
      ...prev,
      tabs: [{
        ...prev.tabs[0],
        root: { type: 'leaf', sessionId: 'second-session' },
        focusedSessionId: 'second-session',
      }],
      sessions: {
        'second-session': {
          ...prev.sessions['second-session'],
          title: 'Edited while recovering',
        },
      },
    }))
    harness.setRuntimes(prev => ({
      'second-session': {
        ...prev['second-session'],
        draftInput: 'newer draft',
        queuedMessages: [{ content: 'live feed state', timestamp: 'now' }],
      },
    }))

    second.resolve({
      ok: true,
      disposition: 'spawned',
      snapshot: {
        sessionId: 'second-session',
        kind: 'codex',
        cwd: '/tmp/project',
        lifecycle: 'live',
        input: { ready: true, revision: 3, reason: 'ready' },
      },
    })
    await expect(bootstrap).resolves.toEqual({
      restoredSessions: 2,
      expectedSessions: 2,
      complete: true,
    })

    expect(harness.state().tabs[0].root).toEqual({
      type: 'leaf',
      sessionId: 'second-session',
    })
    expect(harness.state().sessions['stable-session']).toBeUndefined()
    expect(harness.state().sessions['second-session'].title).toBe('Edited while recovering')
    expect(harness.runtimes()['stable-session']).toBeUndefined()
    expect(harness.runtimes()['second-session']).toMatchObject({
      processStatus: 'started',
      draftInput: 'newer draft',
      queuedMessages: [{ content: 'live feed state', timestamp: 'now' }],
    })
  })

  it('bounds a never-settling recovery, cancels main ownership, and completes bootstrap', async () => {
    const persisted = makePersisted()
    const harness = makeHarness()
    const cancelSessionRecovery = vi.fn(async () => true)
    const recoveryApi = {
      recoverSession: vi.fn(() => new Promise<never>(() => {})),
      cancelSessionRecovery,
      defaultCwd: vi.fn(async () => '/tmp/fallback'),
    }

    const result = await rehydrateWorkspace(
      persisted,
      harness.refs,
      harness.setState,
      harness.setRuntimes,
      harness.setTileTabs,
      vi.fn(),
      recoveryApi,
      5,
    )

    expect(result).toEqual({ restoredSessions: 0, expectedSessions: 1, complete: true })
    expect(cancelSessionRecovery).toHaveBeenCalledWith({
      sessionId: 'stable-session',
      kind: 'claude',
      cwd: '/tmp/project',
    })
    expect(harness.state().tabs[0].root).toEqual({
      type: 'leaf',
      sessionId: 'stable-session',
    })
    expect(harness.runtimes()['stable-session']).toMatchObject({
      processStatus: 'failed',
      recoveryFailureCode: 'cancelled',
      inputReady: false,
    })
  })

  it('preserves a parked agent draft and Dispatch focus without spawning its backend', async () => {
    const persisted = makePersisted()
    persisted.sessions['parked-session'] = {
      cwd: '/tmp/project',
      kind: 'codex',
      title: 'Parked review',
    }
    persisted.detachedSessions = {
      'parked-session': {
        sessionId: 'parked-session',
        surface: 'dispatch',
        projectTabId: 'tab-1',
        projectTabTitle: 'Project',
        projectTabIndex: 0,
        detachedAt: 42,
      },
    }
    persisted.dispatchMode = {
      scope: 'project',
      focusedSessionId: 'parked-session',
    }
    persisted.drafts = {
      ...persisted.drafts,
      'parked-session': 'finish this after restart',
    }
    const harness = makeHarness()
    const recoverSession = vi.fn(async () => ({
      ok: true as const,
      disposition: 'adopted' as const,
      snapshot: {
        sessionId: 'stable-session',
        kind: 'claude' as const,
        cwd: '/tmp/project',
        lifecycle: 'live' as const,
        input: { ready: true, revision: 1, reason: 'ready' as const },
      },
    }))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        recoverSession,
        cancelSessionRecovery: vi.fn(async () => true),
        defaultCwd: vi.fn(),
      },
    })

    const result = await rehydrateWorkspace(
      persisted,
      harness.refs,
      harness.setState,
      harness.setRuntimes,
      harness.setTileTabs,
      vi.fn(),
    )

    // WHY this assertion is stricter than merely checking the metadata row:
    // parked agents deliberately have no provider process after restart, but
    // they are still first-class workspace owners. Losing either their draft
    // or the Dispatch selection makes a successful rehydrate feel like data
    // loss and sends the next command to a different agent.
    expect(recoverSession).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ restoredSessions: 1, expectedSessions: 1, complete: true })
    expect(harness.state().detachedSessions['parked-session']).toMatchObject({
      sessionId: 'parked-session',
      projectTabId: 'tab-1',
    })
    expect(harness.state().dispatchMode).toMatchObject({
      focusedSessionId: 'parked-session',
    })
    expect(harness.runtimes()['parked-session']).toMatchObject({
      processStatus: 'idle',
      inputReady: false,
      draftInput: 'finish this after restart',
    })
  })
})
