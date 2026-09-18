import { describe, expect, it, vi } from 'vitest'
import type { MutableRefObject } from 'react'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { PersistedWorkspace } from '@renderer/workspace/persistence'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionId, SessionMeta, WorkspaceState } from '@renderer/workspace/types'
import type {
  SessionRecoverOptions,
  SessionRecoverResult,
} from '@shared/types/session'

// Same mock as the sibling recovery suite: rehydrate imports the perf
// client unconditionally and this tier has no renderer globals to back it.
vi.mock('@renderer/performance/client', () => ({
  mark: vi.fn(),
  span: () => ({ end: vi.fn(), fail: vi.fn() }),
  measure: <T,>(name: string, fn: () => T | Promise<T>) => fn(),
}))

import { rehydrateWorkspace } from './rehydrate'
import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'
import {
  activeProjectIdOfWorkspace,
  projectIdOfSession,
  projectsOfWorkspace,
  stageOfWorkspace,
} from '@renderer/workspace/workspaceStage'
import { ownerV2Workspace } from '@renderer/workspace/workspaceShape.ownerV2Fixture'

// Tier: integration. One fake, at the preload-bridge seam — every layer
// above it (ownership projection, rehydrate's commit chain, dispatch row
// construction, the live v3 stage/project selectors) runs for real against
// the RECORDED owner fixture. These tests protect the boot contract of the
// unified layout (#992): whatever a real v2 workspace.json contains, the
// app comes up on one stage over one pool, with project affinity intact.
//
// The companion unit suites pin the rules piecewise (workspaceShape.test.ts
// for the persisted migration, workspaceStage.test.ts for derivation over
// synthetic state); what only this file can catch is the layers disagreeing
// — e.g. rehydrate's committed state failing the selector that the render
// path will run one frame later.

function ref<T>(current: T): MutableRefObject<T> {
  return { current }
}

/**
 * Recovery fake: every requested session "starts" and is immediately live
 * and input-ready. The unified-layout boot contract does not depend on
 * provider behavior — only on rehydrate resolving every live-process leaf —
 * so one uniform happy outcome isolates the layout integration from the
 * provider matrix (sessionRecovery.integration.test.ts owns that matrix).
 */
function makeLiveRecoveryApi(calls: SessionRecoverOptions[] = []) {
  return {
    recoverSession: vi.fn(async (options: SessionRecoverOptions): Promise<SessionRecoverResult> => {
      calls.push(options)
      return {
        ok: true,
        disposition: 'spawned',
        snapshot: {
          sessionId: options.sessionId,
          sessionRunId: `run-${options.sessionId}`,
          kind: options.kind ?? 'claude',
          ...(options.providerRuntime ? { providerRuntime: options.providerRuntime } : {}),
          cwd: options.cwd,
          lifecycle: 'live',
          input: { ready: true, revision: 1 },
        },
      }
    }),
    cancelSessionRecovery: vi.fn(async () => true),
    defaultCwd: vi.fn(async () => '/tmp/fallback'),
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
    setTileTabs(_next: unknown) {
      // The unified layout drops tile tabs; rehydrate still offers the
      // setter. Recording it is enough for this suite.
    },
  }
}

/** A pure-grid v2 workspace: multi-pane tab, no dispatchMode anywhere. */
function gridHeavyV2Workspace(): PersistedWorkspace {
  const sessions: Record<SessionId, SessionMeta> = {
    's-a1': { cwd: '/x/app', kind: 'claude' },
    's-a2': { cwd: '/x/app', kind: 'claude' },
    's-a3': { cwd: '/x/app', kind: 'terminal' },
    's-b1': { cwd: '/x/service', kind: 'claude' },
  }
  return {
    tabs: [
      {
        id: 'tab-a',
        title: 'app',
        focusedSessionId: 's-a1',
        root: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.66,
          a: { type: 'leaf', sessionId: 's-a1' },
          b: {
            type: 'split',
            direction: 'horizontal',
            ratio: 0.5,
            a: { type: 'leaf', sessionId: 's-a2' },
            b: { type: 'leaf', sessionId: 's-a3' },
          },
        },
      },
      {
        id: 'tab-b',
        title: 'service',
        focusedSessionId: 's-b1',
        root: { type: 'leaf', sessionId: 's-b1' },
      },
    ],
    activeTabId: 'tab-a',
    sessions,
  }
}

describe('unified layout boot — recorded owner workspace', () => {
  it('boots the v2 dispatch workspace onto its intact stage over the full pool', async () => {
    const harness = makeHarness()
    const calls: SessionRecoverOptions[] = []
    const result = await rehydrateWorkspace(
      ownerV2Workspace,
      harness.refs,
      harness.setState,
      harness.setRuntimes,
      harness.setTileTabs,
      vi.fn(),
      makeLiveRecoveryApi(calls),
    )

    // Only the three tab leaves are live-spawned (hibernated dispatch pool
    // members stay parked) — the #258 fork-bomb guard, observed end-to-end.
    expect(result.complete).toBe(true)
    expect(calls.map(call => call.sessionId).sort()).toEqual(
      ['575880c6-d447-49b8-aa9b-64705d70c287', '5cf66257-4284-40a7-868e-68ea84457063', '9bb36de4-39a0-434b-b4b1-00f017d759bd'].sort(),
    )

    const state = harness.state()
    // The stored grid is the workspace: same lanes, same ragged rows, same
    // focused lane the file had — byte-faithful continuity for the user's
    // actual working shape.
    expect(state.dispatchMode?.tiled?.lanes).toHaveLength(12)
    expect(state.dispatchMode?.tiled?.rows).toEqual([
      { length: 6, capChildren: false, indexFraction: 0.1, height: 0.5869481693862371 },
      { length: 6, height: 0.41305183061376294, indexFraction: 0.1 },
    ])
    expect(state.dispatchMode?.tiled?.focusedLane).toBe(10)
    // The selector returns the STORED grid by reference when one exists —
    // the identity contract lane memos depend on.
    expect(stageOfWorkspace(state)).toBe(state.dispatchMode?.tiled)

    // Projects and pool affinity through the live selectors.
    expect(projectsOfWorkspace(state)).toHaveLength(3)
    expect(activeProjectIdOfWorkspace(state)).toBe('e0224b91-da18-4b20-9cc0-da491569a6b5')
    expect(projectIdOfSession(state, '575880c6-d447-49b8-aa9b-64705d70c287')).toBe(
      'e0224b91-da18-4b20-9cc0-da491569a6b5',
    )
    expect(projectIdOfSession(state, 'e6e19a29-f8b4-44da-bb9a-38fcfca2a314')).toBe(
      '3bf27c7f-2e3a-4da1-a35a-e013ad86f937',
    )

    // The dispatch rows the lanes resolve from include terminals and the
    // extension view: pool citizens, in the same visible order the user
    // had. 17 owned sessions, none invisible.
    const rows = buildVisibleDispatchRows(state)
    expect(rows).toHaveLength(17)
    expect(rows.some(row => row.sessionId === '20c09242-4210-433b-b4cd-c0d31b47c507')).toBe(true)
    expect(rows.some(row => row.sessionId === '7327ced2-fb07-4b63-a357-50d3f94f8fb6')).toBe(true)
  })

  it('keeps every lane session resolvable in the index after boot', async () => {
    const harness = makeHarness()
    await rehydrateWorkspace(
      ownerV2Workspace,
      harness.refs,
      harness.setState,
      harness.setRuntimes,
      harness.setTileTabs,
      vi.fn(),
      makeLiveRecoveryApi(),
    )
    const state = harness.state()
    const rowIds = new Set(buildVisibleDispatchRows(state).map(row => row.sessionId))
    const laneIds = (state.dispatchMode?.tiled?.lanes ?? [])
      .map(lane => lane.selectedSessionId)
      .filter((id): id is SessionId => id !== undefined)
    // Every lane's occupant must be selectable from the index after a real
    // boot — a lane pointing at a row the index cannot produce is the
    // "selected-but-unresolvable lane" bug class, caught here end-to-end
    // instead of by imagination.
    for (const id of laneIds) {
      expect(rowIds.has(id), `lane session ${id} missing from index rows`).toBe(true)
    }
  })
})

describe('unified layout boot — pure-grid v2 workspace', () => {
  it('boots onto the derived seeded default stage with tab leaves pooled', async () => {
    const harness = makeHarness()
    const calls: SessionRecoverOptions[] = []
    const result = await rehydrateWorkspace(
      gridHeavyV2Workspace(),
      harness.refs,
      harness.setState,
      harness.setRuntimes,
      harness.setTileTabs,
      vi.fn(),
      makeLiveRecoveryApi(calls),
    )
    expect(result.complete).toBe(true)
    expect(calls).toHaveLength(4) // every leaf of the multi-pane tab + tab-b

    const state = harness.state()
    // No stored grid: the derived stage is the workspace — [2], lane 0
    // seeded with the session the user was commanding (their active tab's
    // focus), everything else pooled. This is the accepted-loss boot: the
    // multi-pane arrangement is NOT reconstructed, and this test pins that
    // the pooled leaves are still reachable rather than vanished.
    expect(state.dispatchMode).toBeNull()
    const stage = stageOfWorkspace(state)
    expect(stage.rows).toEqual([{ length: 2 }])
    expect(stage.lanes).toEqual([{ selectedSessionId: 's-a1' }, {}])
    expect(stage.focusedLane).toBe(0)

    const rowIds = new Set(buildVisibleDispatchRows(state).map(row => row.sessionId))
    // Same-tab leaves pool into the visible index.
    expect(rowIds.has('s-a2')).toBe(true)
    expect(rowIds.has('s-a3')).toBe(true)
    // TRANSITIONAL (until scope dies in the stage-4 fleet work): with no
    // dispatchMode the index defaults to PROJECT scope, so the other
    // project's leaf is pooled-and-alive but not listed until the project
    // chip makes it active. The assertion pins both halves — not vanished
    // (sessions map owns it, affinity intact), not yet fleet-visible — so
    // the stage-4 flip to global has a test to update, not a surprise.
    expect(rowIds.has('s-b1')).toBe(false)
    expect(state.sessions['s-b1']).toBeDefined()
    expect(projectIdOfSession(state, 's-b1')).toBe('tab-b')

    // Pool affinity survived boot through the live selector.
    expect(projectIdOfSession(state, 's-a3')).toBe('tab-a')
    expect(projectsOfWorkspace(state)).toEqual([
      { id: 'tab-a', title: 'app' },
      { id: 'tab-b', title: 'service' },
    ])
  })

  it('keeps the seed honest when the active focus names a detached (parked) session', async () => {
    // The owner fixture's real quirk, isolated: tab.focus pointing at a
    // detached session. Here the workspace HAS a grid, so the seed path is
    // not taken — the assertion pins that a dangling-ish focus cannot leak
    // into a derived default lane on boot when a grid exists (it must
    // return the stored grid untouched, not "improve" it).
    const persisted = gridHeavyV2Workspace()
    persisted.tabs[0]!.focusedSessionId = 's-b1'
    const harness = makeHarness()
    await rehydrateWorkspace(
      { ...persisted, dispatchMode: { scope: 'global', tiled: { lanes: [{}, {}], focusedLane: 1 } } },
      harness.refs,
      harness.setState,
      harness.setRuntimes,
      harness.setTileTabs,
      vi.fn(),
      makeLiveRecoveryApi(),
    )
    const state = harness.state()
    expect(stageOfWorkspace(state)).toBe(state.dispatchMode?.tiled)
    expect(state.dispatchMode?.tiled?.focusedLane).toBe(1)
  })
})

describe('unified layout boot — runtime seeds survive a first interaction', () => {
  it('commits an empty runtime for parked pool members (no spawn, but addressable)', async () => {
    const harness = makeHarness()
    await rehydrateWorkspace(
      ownerV2Workspace,
      harness.refs,
      harness.setState,
      harness.setRuntimes,
      harness.setTileTabs,
      vi.fn(),
      makeLiveRecoveryApi(),
    )
    const runtimes = harness.refs.latestRuntimesRef.current
    // Live leaves got real recovered runtimes.
    expect(runtimes['575880c6-d447-49b8-aa9b-64705d70c287']).toMatchObject({
      processStatus: 'started',
    })
    // Parked pool members exist in the runtime map in the hibernated idle
    // shape — placing one into a lane later must find runtime state to
    // wake, not a hole.
    const parked = runtimes['6d6cac8c-fe3d-4f5e-82e3-740036b4aebd']
    expect(parked).toBeDefined()
    expect(parked?.processStatus ?? emptyRuntime().processStatus).toBeTruthy()
  })
})
