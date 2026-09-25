import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionSpawnOptions } from '@preload/api/types'
import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import { useSessionActions } from './session'
import { makeRefs, stateWriter } from './testing/paneActionsHarness'
import type { WorkspaceState } from '@renderer/workspace/types'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'

// #1239: toggling Dangerous Agents By Default reloads every live agent. An
// agent whose respawn failed used to be DELETED from the workspace (and its
// project, if it left one empty) with no message, after its backend had
// already been killed. It must stay, marked failed with the reason, so the
// pane can Retry.

vi.mock('./initialHistory', () => ({ loadInitialHistoryForSession: vi.fn(async () => undefined) }))
const originalApi = window.api
afterEach(() => { cleanup(); window.api = originalApi; vi.useRealTimers() })

it('keeps an agent whose respawn failed, marked failed with the spawn error, and restarts the others', async () => {
  vi.useFakeTimers()
  const state = {
    tabs: [{ id: 'project', title: 'Project' }, { id: 'other', title: 'Other' }],
    activeTabId: 'project',
    sessions: {
      healthy: { cwd: '/project', kind: 'codex', providerSessionId: 'native-healthy', projectId: 'project', joinedAt: 0 },
      broken: { cwd: '/other', kind: 'claude', providerSessionId: 'native-broken', projectId: 'other', joinedAt: 0 },
    },
    pinnedSessionIds: [],
    stage: oneLaneStage('broken'),
  } as WorkspaceState
  const refs = makeRefs(state), writer = stateWriter(state, refs)
  // Both have a backend: reload restarts only sessions with one (#992).
  refs.latestRuntimesRef.current = {
    healthy: { ...emptyRuntime(), processStatus: 'started' },
    broken: { ...emptyRuntime(), processStatus: 'started', draftInput: 'half-typed' },
  }
  const setRuntimes = (update: Record<string, SessionRuntime> | ((prev: Record<string, SessionRuntime>) => Record<string, SessionRuntime>)) => {
    refs.latestRuntimesRef.current = typeof update === 'function' ? update(refs.latestRuntimesRef.current) : update
  }
  const spawnSession = vi.fn(async (options: SessionSpawnOptions) => {
    if (options.cwd === '/other') throw new Error('Claude Code CLI not found')
    return { sessionId: 'healthy-2', providerSessionId: options.resumeSessionId }
  })
  window.api = { ...originalApi, spawnSession, killOwnedSession: vi.fn(async () => true), controlGoalLoop: vi.fn(async () => null) }
  const hook = renderHook(() => useSessionActions(state, writer.setState, setRuntimes, refs))

  await act(async () => { await hook.result.current.reloadAgentSessions(true); await vi.runAllTimersAsync() })

  const after = writer.getState()
  // The healthy agent restarted under a new id.
  expect(after.sessions.healthy).toBeUndefined()
  expect(after.sessions['healthy-2']).toBeDefined()
  // The broken one is still there, in its project and its lane.
  expect(after.sessions.broken).toMatchObject({ projectId: 'other', providerSessionId: 'native-broken' })
  expect(after.tabs.map(tab => tab.id)).toContain('other')
  expect(after.stage.lanes[after.stage.focusedLane]!.selectedSessionId).toBe('broken')
  // ...and says what happened, with Retry's state.
  expect(refs.latestRuntimesRef.current.broken).toMatchObject({
    processStatus: 'failed',
    processError: 'Claude Code CLI not found',
    inputReady: false,
    draftInput: 'half-typed',
  })
})
