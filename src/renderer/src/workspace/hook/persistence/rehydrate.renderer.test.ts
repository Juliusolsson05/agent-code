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
    latestRuntimesRef: ref(runtimes),
  } as unknown as WorkspaceRefs

  return {
    refs,
    state: () => state,
    runtimes: () => runtimes,
    setState: (next: WorkspaceState | ((prev: WorkspaceState) => WorkspaceState)) => {
      state = typeof next === 'function' ? next(state) : next
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
      ...emptyRuntime(),
      processStatus: 'failed',
      processError: 'Owned by another project',
      inputReady: false,
    })
  })
})
