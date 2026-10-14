import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@renderer/app-state/store'
import { emptyRuntime } from '@renderer/session-runtime/state'
import { useDispatchActions } from './dispatch'
import { useSessionActions } from './session'
import { useSidekickRowActions } from './sidekick'
import { makeRefs } from './testing/paneActionsHarness'
vi.mock('@renderer/workspace/hook/actions/initialHistory', () => ({ loadInitialHistoryForSession: vi.fn(async () => undefined) }))
const original = useAppStore.getState()
const originalApi = window.api
afterEach(() => { cleanup(); useAppStore.setState(original, true); window.api = originalApi })

// Sidekick rows through the REAL workspace actions (#1493). Before the second
// ownership clause each of these silently did the wrong thing on a sidekick:
// replaceSession's canCommit refused it (Reload Agent / provider switch were
// no-ops), Reload All deleted the row, and nothing stopped a pin or a lane
// from pointing at it.

const SIDEKICK = '00000000-0000-4000-8000-000000000002'
const hermesRow = { kind: 'hermes' as const, cwd: '/home/recorded', providerSessionId: 'stored-hermes', providerSessionIdSource: 'provider-follow' as const, remoteConnectionId: 'conn-recorded', sidekickId: SIDEKICK }

function seed(extra: Record<string, unknown> = {}) {
  useAppStore.setState({ workspaceState: { ...original.workspaceState, activeTabId: 'project',
    tabs: [{ id: 'project', title: 'Project' }],
    sessions: {
      lane: { kind: 'claude', cwd: '/recorded/project', providerSessionId: 'native-lane', projectId: 'project', joinedAt: 0 },
      sidekick: hermesRow,
    },
    ...extra,
  }, workspaceRuntimes: { lane: emptyRuntime(), sidekick: { ...emptyRuntime(), processStatus: 'started' } } })
  const state = useAppStore.getState().workspaceState
  const refs = makeRefs(state)
  refs.latestRuntimesRef.current = useAppStore.getState().workspaceRuntimes
  refs.stateRef.current = state
  return { state, refs }
}

it('Reload Agent on a sidekick commits a successor that is still the same sidekick', async () => {
  const { state, refs } = seed()
  window.api = { ...originalApi, spawnSession: vi.fn(async () => ({ sessionId: 'sidekick-successor' })), killOwnedSession: vi.fn(async () => true), carryWorkflowRuns: vi.fn(async () => undefined), carryOrchestrationParent: vi.fn(async () => undefined), controlGoalLoop: vi.fn(async () => null) }
  const mounted = renderHook(() => useSessionActions(state, useAppStore.getState().setWorkspaceState, useAppStore.getState().setWorkspaceRuntimes, refs))
  let successor: string | undefined
  await act(async () => {
    successor = await mounted.result.current.replaceSession('/home/recorded', { targetSessionId: 'sidekick', kind: 'hermes', resumeSessionId: 'stored-hermes' })
  })
  expect(successor).toBe('sidekick-successor')
  const sessions = useAppStore.getState().workspaceState.sessions
  expect(sessions.sidekick).toBeUndefined()
  expect(sessions['sidekick-successor']).toMatchObject({ sidekickId: SIDEKICK })
  expect(sessions['sidekick-successor']!.projectId).toBeUndefined()
})

it('refuses to pin a sidekick or put one in a lane', async () => {
  const { refs } = seed({ stage: { lanes: [{}], rows: [{ length: 1 }], focusedLane: 0 } })
  const ensureSessionLive = vi.fn(async (sessionId: string) => ({ sessionId }))
  const dispatch = renderHook(() => useDispatchActions(useAppStore.getState().setWorkspaceState, useAppStore.getState().setWorkspaceRuntimes, refs, ensureSessionLive as never, vi.fn()))
  // Each guard asserted on its own: a later write must not mask an earlier one.
  act(() => { dispatch.result.current.pinSession('sidekick') })
  expect(useAppStore.getState().workspaceState.pinnedSessionIds).toEqual([])
  act(() => { dispatch.result.current.setPinnedSessionIds(['sidekick', 'lane']) })
  expect(useAppStore.getState().workspaceState.pinnedSessionIds).toEqual(['lane'])
  await act(async () => { await dispatch.result.current.selectTiledLaneSession(0, 'sidekick') })
  const state = useAppStore.getState().workspaceState
  expect(state.stage.lanes[0]!.selectedSessionId).toBeUndefined()
  expect(ensureSessionLive).not.toHaveBeenCalled()
})

it('releases a moved-away sidekick row without touching the lane agent or killing anything', async () => {
  seed()
  const killOwnedSession = vi.fn(async () => true)
  window.api = { ...originalApi, killOwnedSession }
  const rows = renderHook(() => useSidekickRowActions(useAppStore.getState().setWorkspaceState, useAppStore.getState().setWorkspaceRuntimes))
  act(() => { rows.result.current.releaseSidekickRow('sidekick') })
  const after = useAppStore.getState()
  expect(after.workspaceState.sessions.sidekick).toBeUndefined()
  expect(after.workspaceRuntimes.sidekick).toBeUndefined()
  expect(after.workspaceState.sessions.lane).toBeDefined()
  expect(killOwnedSession).not.toHaveBeenCalled()
  // A lane agent is never released through this path.
  act(() => { rows.result.current.releaseSidekickRow('lane') })
  expect(useAppStore.getState().workspaceState.sessions.lane).toBeDefined()
})

it('adopts a record as a row with its draft, and never over a live row', () => {
  seed()
  const rows = renderHook(() => useSidekickRowActions(useAppStore.getState().setWorkspaceState, useAppStore.getState().setWorkspaceRuntimes))
  act(() => { rows.result.current.adoptSidekickRow('moved-in', { ...hermesRow, projectId: 'stray' } as never, 'half a prompt') })
  expect(useAppStore.getState().workspaceState.sessions['moved-in']).toMatchObject({ sidekickId: SIDEKICK })
  expect(useAppStore.getState().workspaceState.sessions['moved-in']!.projectId).toBeUndefined()
  expect(useAppStore.getState().workspaceRuntimes['moved-in']!.draftInput).toBe('half a prompt')
  act(() => { rows.result.current.adoptSidekickRow('sidekick', { ...hermesRow, title: 'stale record' }, 'stale') })
  expect(useAppStore.getState().workspaceState.sessions.sidekick!.title).toBeUndefined()
})
