import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
import { freshStage } from '@renderer/workspace/dispatch/gridShape'

// The stage guarantee (#992): every boot path lands on a STORED stage whose
// shape depends on where the workspace came from — fresh installs get one row
// × one lane (nothing to explain, plan §4.5), imported v2 workspaces without a
// lane grid get the migration default [2] (plan §6.4), and a workspace that
// already HAS a grid keeps it exactly. This suite pins all three at the
// bootstrap seam, with rehydrate real and recovery faked at the preload
// bridge.
//
// WHAT CHANGED, because the assertions changed kind: through stage 2 of the
// merge bootstrap guaranteed this by CALLING enterTiledDispatch after each
// path, and the suite counted those calls ([1], [2], never). The action is
// deleted. Bootstrap now does nothing about the stage at all: the store starts
// on a one-lane stage, newTab fills its empty focused lane, and rehydrate
// publishes the migrated stage in its first commit. So the suite asserts the
// STATE each path ends on — which is the thing the user sees, and is a
// stronger claim than "a function was called with [2]".

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
    pinnedSessionIds: [],
    stage: freshStage(),
  } satisfies WorkspaceState as WorkspaceState
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
    // one live leaf, the shape bootstrap's autosave unlock checks for — and
    // place it in the empty focused lane, as the real action does. That rule
    // is pinned against the REAL hook in actions/newTabPlacement.renderer
    // .test.tsx; it is mirrored here only so this suite can observe that
    // bootstrap leaves the result alone.
    const leaf: SessionId = 'fresh-session'
    state = {
      ...state,
      stage: { ...state.stage, lanes: [{ selectedSessionId: leaf }] },
      tabs: [
        {
          id: 'tab-1',
          title: 'Project',
        },
      ],
      activeTabId: 'tab-1',
      sessions: { ...state.sessions, [leaf]: { cwd: '/tmp/fresh', kind: 'claude', projectId: 'tab-1', joinedAt: 0 } },
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
      harness.newTab,
      setBootstrapComplete,
      setRestoreStatus,
    ),
  )
  return { unmount, setBootstrapComplete, setRestoreStatus }
}

describe('bootstrap stage guarantee', () => {
  it('lands a fresh install on one lane showing its one agent', async () => {
    const harness = makeHarness(null)
    const { unmount, setBootstrapComplete } = renderBootstrap(harness)
    await vi.waitFor(() => expect(harness.newTab).toHaveBeenCalled())
    // Autosave unlocked: the fresh workspace is real and savable.
    await vi.waitFor(() => expect(setBootstrapComplete).toHaveBeenCalledWith(true))
    expect(harness.state().stage).toEqual({
      lanes: [{ selectedSessionId: 'fresh-session' }],
      rows: [{ length: 1 }],
      focusedLane: 0,
    })
    unmount()
  })

  it('lands an imported grid-only workspace on the seeded [2] default', async () => {
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
    const { unmount, setBootstrapComplete } = renderBootstrap(harness)
    await vi.waitFor(() => expect(setBootstrapComplete).toHaveBeenCalledWith(true))
    // NOT the fresh [1]: an importing user demonstrably has agents, and the
    // second lane is what shows that a lane is a slot.
    expect(harness.state().stage).toEqual({
      lanes: [{ selectedSessionId: 's-a1' }, {}],
      rows: [{ length: 2 }],
      focusedLane: 0,
    })
    expect(harness.newTab).not.toHaveBeenCalled()
    unmount()
  })

  it('keeps a stored stage exactly, including lanes the user left empty', async () => {
    const stage = {
      lanes: [{}, { selectedSessionId: 's-a1' }, {}],
      rows: [{ length: 3 }],
      focusedLane: 2,
    }
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
      stage,
      sessions: { 's-a1': { cwd: '/x/app', kind: 'claude' } },
    }
    const harness = makeHarness(persisted)
    const { unmount, setBootstrapComplete } = renderBootstrap(harness)
    await vi.waitFor(() => expect(setBootstrapComplete).toHaveBeenCalledWith(true))
    // Lane 0 is empty and FOCUS is on an empty lane — both are the user's
    // choices. A boot that "helpfully" seeded lane 0 with the focused pane
    // (the entry seed) here would be #681's auto-fill on every launch; the
    // seed applies only to a file that never had lanes.
    expect(harness.state().stage).toEqual(stage)
    unmount()
  })

  // #1245 through the real bootstrap: a damaged but restorable file must not
  // land in the locked recovery shell. Built on the owner's real v3 workspace.
  const realV3 = (): Record<string, any> => (JSON.parse(readFileSync(join(import.meta.dirname,
    '../../../../../../testing/fixtures/workspace-v3/2026-09-20-live-workspace.sanitized.json'), 'utf8')) as { windows: { workspace: Record<string, any> }[] }).windows[0]!.workspace

  // WHY autosave is the signal: the recovery shell deliberately keeps autosave
  // LOCKED to protect the file on disk, while a restore unlocks it.
  it('restores every project instead of falling back to recovery when one lane is null', async () => {
    const workspace = realV3()
    workspace.stage.lanes[0] = null
    const harness = makeHarness(workspace as unknown as PersistedWorkspace)
    const { unmount, setBootstrapComplete } = renderBootstrap(harness)
    await vi.waitFor(() => expect(setBootstrapComplete).toHaveBeenCalled())
    expect(setBootstrapComplete).toHaveBeenLastCalledWith(true)
    const restoredIds = harness.state().tabs.map(tab => tab.id)
    for (const project of workspace.projects as Array<{ id: string }>) expect(restoredIds).toContain(project.id)
    unmount()
  })

  it('restores (an empty pool) instead of falling back to recovery when the sessions map is missing', async () => {
    const workspace = realV3()
    delete workspace.sessions
    const harness = makeHarness(workspace as unknown as PersistedWorkspace)
    const { unmount, setBootstrapComplete } = renderBootstrap(harness)
    await vi.waitFor(() => expect(setBootstrapComplete).toHaveBeenCalled())
    expect(setBootstrapComplete).toHaveBeenLastCalledWith(true)
    unmount()
  })

  it('keeps autosave LOCKED when a real v2 tab entry is replaced by null (steering q21)', async () => {
    const recorded = JSON.parse(readFileSync(join(import.meta.dirname,
      '../../../../../../testing/fixtures/workspace-v2/2026-09-19-live-workspace.sanitized.json'), 'utf8')) as { windows: { workspace: Record<string, any> }[] }
    const workspace = recorded.windows[0]!.workspace
    workspace.tabs[1] = null
    const harness = makeHarness(workspace as unknown as PersistedWorkspace)
    const { unmount, setBootstrapComplete, setRestoreStatus } = renderBootstrap(harness)
    // setRestoreStatus is published on every path, after the autosave decision.
    await vi.waitFor(() => expect(setRestoreStatus).toHaveBeenCalled())
    // The recovery shell, never a restore: a restore here would autosave 6
    // of the file's 27 agents over it.
    expect(setRestoreStatus).toHaveBeenLastCalledWith('persisted-fallback')
    expect(setBootstrapComplete).not.toHaveBeenCalledWith(true)
    unmount()
  })
})
