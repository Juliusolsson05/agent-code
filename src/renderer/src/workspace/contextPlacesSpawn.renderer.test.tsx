import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@renderer/app-state/hooks'
import { emptyRuntime } from '@renderer/session-runtime/state'
import { useWorkspace } from '@renderer/workspace/hook'

import { mountPaneActions } from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'

// Context-places spawn (#992 §4.3) — the operator's chosen rule, end to end
// through the real placement owner:
//
//   an EMPTY focused lane is filled by a spawn from it (the one continuity
//   write U2 allows); an OCCUPIED lane is never displaced, and the spawn
//   lands in the pool wearing a "new" badge until the user places it.
//
// The lane-shape half (fill vs refuse) is pinned per-spawn-site in the
// placement suites (dispatchTerminalPlacement, controlPlacement,
// extensionPlacement). What lives HERE is the badge lifecycle, which crosses
// hooks (pane actions mark it; dispatch actions and agent-index navigation
// retire it, see pooledSpawnBadge.ts) and therefore has no single-suite home.

// The whole-hook case suppresses only process/IPC ingress, as the
// orchestration runtime test does.
vi.mock('@renderer/workspace/hook/ipc/useIpcSubscriptions', () => ({ useIpcSubscriptions: () => undefined }))
vi.mock('@renderer/workspace/hook/ipc/useWorkspaceAdoption', () => ({ useWorkspaceAdoption: () => undefined }))
vi.mock('@renderer/workspace/hook/persistence/useBootstrap', () => ({ useBootstrap: () => undefined }))
vi.mock('@renderer/features/sessionFeed/SessionFeedContext', () => ({ useSessionFeed: () => ({}) }))
const originalStore = useAppStore.getState()
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
afterEach(() => {
  cleanup()
  useAppStore.setState(originalStore, true)
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})
const stubWindowApi = () => Object.defineProperty(window, 'api', { configurable: true, value: {
  onOrchestrationRequest: () => () => undefined,
  onAgentManagementRequest: () => () => undefined,
  reportSessionLifecycle: vi.fn(),
  appendFeedDebugLog: async () => undefined,
} })

function workspace(occupant?: SessionId): WorkspaceState {
  return {
    tabs: [{ id: 'p', title: 'Project' }],
    activeTabId: 'p',
    // `anchor` always exists: the spawn override names it as the anchor, and
    // the anchored spawn must resolve a real row. `occupant` only decides
    // whether the focused LANE shows it — which is the entire variable under
    // test.
    sessions: {
      anchor: { kind: 'claude', cwd: '/p', projectId: 'p', joinedAt: 0 },
    },
    stage: oneLaneStage(occupant),
    pinnedSessionIds: [],
  }
}

describe('pooled-spawn badge lifecycle', () => {
  it('marks a spawn that pooled because the focused lane was occupied, and not one that filled an empty lane', async () => {
    const occupied = mountPaneActions(workspace('anchor'), { spawnSessionId: 'spawned' })
    await act(async () => {
      await occupied.actions.createDetachedDispatchAgent({ kind: 'codex' }, { tabId: 'p', anchorSessionId: 'anchor' })
    })
    expect(occupied.runtimes().spawned?.pooledSpawnAt).toEqual(expect.any(Number))

    const empty = mountPaneActions(workspace(), { spawnSessionId: 'filled' })
    await act(async () => {
      await empty.actions.createDetachedDispatchAgent({ kind: 'codex' }, { tabId: 'p', anchorSessionId: 'anchor' })
    })
    // Filling the lane ANSWERED the placement question at spawn time; a badge
    // on a session the user is looking at would be noise.
    // `?? null`: a fill writes NO badge entry at all, and "absent" and
// "explicitly null" are the same answer to "is it badged".
    expect(empty.runtimes().filled?.pooledSpawnAt ?? null).toBeNull()
    expect(empty.getState().stage.lanes[0]?.selectedSessionId).toBe('filled')
  })

  it('marks a linked agent, which never takes a lane under context-places', async () => {
    const harness = mountPaneActions(workspace('anchor'), { spawnSessionId: 'child' })
    await act(async () => {
      await harness.actions.createLinkedAgent({ kind: 'codex' }, 'anchor')
    })
    expect(harness.runtimes().child?.pooledSpawnAt).toEqual(expect.any(Number))
    // And nothing moved on screen.
    expect(harness.getState().stage.lanes[0]?.selectedSessionId).toBe('anchor')
  })

  it('is retired by placing the session into a lane through the real workspace hook', async () => {
    // This case used to write the lane by hand and then assert that the badge
    // SURVIVED, which proved only that a hand-written lane is not a placement
    // (#1013 review B called it tautological). The clearing write lives in the
    // dispatch actions, so this mounts the whole workspace hook and places the
    // pooled session the way an index click does.
    useAppStore.setState({
      workspaceState: { ...workspace('anchor'), sessions: {
        anchor: { kind: 'claude', cwd: '/p', projectId: 'p', joinedAt: 0 },
        spawned: { kind: 'codex', cwd: '/p', projectId: 'p', joinedAt: 1 },
      } },
      // 'started' keeps selection on its synchronous path: no wake round-trip.
      workspaceRuntimes: {
        anchor: { ...emptyRuntime(), processStatus: 'started' },
        spawned: { ...emptyRuntime(), processStatus: 'started', pooledSpawnAt: 1 },
      },
    })
    stubWindowApi()
    const hook = renderHook(() => useWorkspace())
    await act(async () => { await hook.result.current.selectTiledLaneSession(0, 'spawned') })
    expect(useAppStore.getState().workspaceState.stage.lanes[0]?.selectedSessionId).toBe('spawned')
    expect(useAppStore.getState().workspaceRuntimes.spawned?.pooledSpawnAt ?? null).toBeNull()
    hook.unmount()
  })
})
