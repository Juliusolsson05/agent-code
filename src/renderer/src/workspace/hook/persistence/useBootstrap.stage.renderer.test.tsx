import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MutableRefObject } from 'react'
import { renderHook } from '@testing-library/react'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { PersistedWorkspace } from '@renderer/workspace/persistence'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'
import type {
  SessionRecoverOptions,
  SessionRecoverResult,
} from '@shared/types/session'

vi.mock('@renderer/performance/client', () => ({
  mark: vi.fn(),
  span: () => ({ end: vi.fn(), fail: vi.fn() }),
  measure: <T,>(name: string, fn: () => T | Promise<T>) => fn(),
}))

import { useBootstrap } from './useBootstrap'

// The stage guarantee (#992): bootstrap seeds a STORED tiled grid exactly
// once, with a shape that depends on where the workspace came from —
// fresh installs get one row × one lane (nothing to explain, plan §4.5),
// imported v2 workspaces without a grid get the migration default [2]
// (plan §6.4), and a workspace that already HAS a grid is never reseeded
// (re-entering would wipe its lanes — enterTiledDispatch is an "enter"
// action, not an upsert). This suite pins all three at the bootstrap seam,
// with rehydrate real and recovery faked at the preload bridge.

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

function makeHarness(persisted: PersistedWorkspace | null) {
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
  const refs = {
    bootRef: ref(false),
    dangerousAgentsRef: ref(false),
    useProxyStreamingRef: ref(false),
    defaultBuiltInMcpDomainsRef: ref([]),
    stateRef: ref(state),
    latestStateRef: ref(state),
    latestRuntimesRef: ref(runtimes),
  } as unknown as WorkspaceRefs

  const newTab = vi.fn(async () => {
    // Minimal stand-in for the real newTab action: mint one project with
    // one live leaf, the shape bootstrap's autosave unlock checks for.
    const leaf: SessionId = 'fresh-session'
    state = {
      ...state,
      tabs: [
        {
          id: 'tab-1',
          title: 'Project',
          root: { type: 'leaf', sessionId: leaf },
          focusedSessionId: leaf,
        },
      ],
      activeTabId: 'tab-1',
      sessions: { ...state.sessions, [leaf]: { cwd: '/tmp/fresh', kind: 'claude' } },
    }
    refs.stateRef.current = state
    refs.latestStateRef.current = state
  })

  const enterTiledDispatch = vi.fn(async (rowLengths: number[]) => {
    // Mirrors the real action's stored-grid write closely enough for the
    // guard to observe: the guarantee test cares THAT and WITH WHAT SHAPE
    // bootstrap calls it, not that lanes materialize (the action's own
    // behavior is covered where the action lives).
    state = {
      ...state,
      dispatchMode: {
        scope: 'global',
        tiled: { lanes: [], rows: rowLengths.map(length => ({ length })), focusedLane: 0 },
      },
    }
    refs.stateRef.current = state
    refs.latestStateRef.current = state
  })

  const api = {
    loadWorkspace: vi.fn(async () =>
      persisted === null ? null : JSON.stringify({ workspace: persisted }),
    ),
    defaultCwd: vi.fn(async () => '/tmp/fresh'),
    recoverSession: vi.fn(async (options: SessionRecoverOptions): Promise<SessionRecoverResult> => ({
      ok: true,
      disposition: 'spawned',
      snapshot: {
        sessionId: options.sessionId,
        sessionRunId: `run-${options.sessionId}`,
        kind: options.kind ?? 'claude',
        cwd: options.cwd,
        lifecycle: 'live',
        input: { ready: true, revision: 1 },
      },
    })),
    cancelSessionRecovery: vi.fn(async () => true),
  }
  Object.defineProperty(window, 'api', { value: api, configurable: true })

  return {
    refs,
    state: () => state,
    runtimes: () => runtimes,
    newTab,
    enterTiledDispatch,
    setState(next: WorkspaceState | ((prev: WorkspaceState) => WorkspaceState)) {
      state = typeof next === 'function' ? next(state) : next
      refs.stateRef.current = state
      refs.latestStateRef.current = state
    },
    setRuntimes(
      next:
        | Record<SessionId, SessionRuntime>
        | ((prev: Record<SessionId, SessionRuntime>) => Record<SessionId, SessionRuntime>),
    ) {
      runtimes = typeof next === 'function' ? next(runtimes) : next
      refs.latestRuntimesRef.current = runtimes
    },
  }
}

function renderBootstrap(harness: ReturnType<typeof makeHarness>) {
  const setBootstrapComplete = vi.fn()
  const setRestoreStatus = vi.fn()
  const { unmount } = renderHook(() =>
    useBootstrap(
      harness.refs,
      harness.setState,
      harness.setRuntimes,
      () => undefined,
      harness.newTab,
      setBootstrapComplete,
      setRestoreStatus,
      'dispatch',
      vi.fn(async () => {}),
      harness.enterTiledDispatch,
    ),
  )
  return { unmount, setBootstrapComplete, setRestoreStatus }
}

describe('bootstrap stage guarantee', () => {
  it('seeds a [1] stage exactly once on a fresh install', async () => {
    const harness = makeHarness(null)
    const { unmount, setBootstrapComplete } = renderBootstrap(harness)
    await vi.waitFor(() => expect(harness.newTab).toHaveBeenCalled())
    await vi.waitFor(() => expect(harness.enterTiledDispatch).toHaveBeenCalledTimes(1))
    expect(harness.enterTiledDispatch).toHaveBeenCalledWith([1])
    // Autosave unlocked: the fresh workspace is real and savable.
    await vi.waitFor(() => expect(setBootstrapComplete).toHaveBeenCalledWith(true))
    unmount()
  })

  it('seeds the migration default [2] for an imported grid-only workspace', async () => {
    const persisted: PersistedWorkspace = {
      tabs: [
        {
          id: 'tab-a',
          title: 'app',
          focusedSessionId: 's-a1',
          root: { type: 'leaf', sessionId: 's-a1' },
        },
      ],
      activeTabId: 'tab-a',
      sessions: { 's-a1': { cwd: '/x/app', kind: 'claude' } },
    }
    const harness = makeHarness(persisted)
    const { unmount } = renderBootstrap(harness)
    await vi.waitFor(() => expect(harness.enterTiledDispatch).toHaveBeenCalledTimes(1))
    expect(harness.enterTiledDispatch).toHaveBeenCalledWith([2])
    expect(harness.newTab).not.toHaveBeenCalled()
    unmount()
  })

  it('never reseeds a workspace that already has a stored grid', async () => {
    const persisted: PersistedWorkspace = {
      tabs: [
        {
          id: 'tab-a',
          title: 'app',
          focusedSessionId: 's-a1',
          root: { type: 'leaf', sessionId: 's-a1' },
        },
      ],
      activeTabId: 'tab-a',
      dispatchMode: {
        scope: 'global',
        tiled: {
          lanes: [{ selectedSessionId: 's-a1' }, {}, {}],
          rows: [{ length: 3 }],
          focusedLane: 0,
        },
      },
      sessions: { 's-a1': { cwd: '/x/app', kind: 'claude' } },
    }
    const harness = makeHarness(persisted)
    const { unmount } = renderBootstrap(harness)
    // Give the whole boot pipeline (rehydrate of one leaf is one tick of
    // recovery plus commits) ample time to wrongly reseed.
    await vi.waitFor(() =>
      expect(harness.state().sessions['s-a1']).toMatchObject({ cwd: '/x/app' }),
    )
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(harness.enterTiledDispatch).not.toHaveBeenCalled()
    unmount()
  })
})
