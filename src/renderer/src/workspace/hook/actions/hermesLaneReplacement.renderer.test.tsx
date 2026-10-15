import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@renderer/app-state/store'
import { emptyRuntime } from '@renderer/session-runtime/state'
import { useSessionActions } from './session'
import { makeRefs } from './testing/paneActionsHarness'
vi.mock('@renderer/workspace/hook/actions/initialHistory', () => ({ loadInitialHistoryForSession: vi.fn(async () => undefined) }))
const original = useAppStore.getState()
const originalApi = window.api
afterEach(() => { cleanup(); useAppStore.setState(original, true); window.api = originalApi })

// "Change Telegram Thread…" (#1501) swaps the pane through replaceSession.
// The routing keys are the recorded T8 lanes (hermes-headless corpus,
// v0.22.0): the plain DM and its topic 7. What broke before the three-state
// option: replaceSession re-applied the OLD pane's key after the caller's
// options, so choosing topic 7 reopened the plain DM, and "Separate chat"
// reopened the thread it was leaving.
const DM = 'agent:main:telegram:dm:111'
const TOPIC = 'agent:main:telegram:dm:111:7'

function harness() {
  useAppStore.setState({ workspaceState: { ...original.workspaceState, activeTabId: 'project',
    tabs: [{ id: 'project', title: 'Project' }],
    sessions: { source: { kind: 'hermes', cwd: '/recorded/project', providerSessionId: '20261014_095555_189ebada', remoteConnectionId: 'vps', hermesLaneKey: DM, projectId: 'project', joinedAt: 0 } },
  }, workspaceRuntimes: { source: emptyRuntime() } })
  const state = useAppStore.getState().workspaceState
  const refs = makeRefs(state)
  refs.latestRuntimesRef.current = useAppStore.getState().workspaceRuntimes
  const spawnSession = vi.fn(async (_options: Record<string, unknown>) => ({ sessionId: 'successor' }))
  // The DEFAULT thread is the one a separate chat must not fall back to.
  const hermesDefaultLane = vi.fn(async () => DM)
  window.api = { ...originalApi, spawnSession, hermesDefaultLane, killOwnedSession: vi.fn(async () => true) } as typeof window.api
  const mounted = renderHook(() => useSessionActions(state, useAppStore.getState().setWorkspaceState, useAppStore.getState().setWorkspaceRuntimes, refs))
  const replace = async (opts: Parameters<typeof mounted.result.current.replaceSession>[1]) => {
    await act(async () => {
      expect(await mounted.result.current.replaceSession('/recorded/project', { targetSessionId: 'source', ...opts })).toBe('successor')
    })
    return spawnSession.mock.calls.at(-1)![0]
  }
  return { replace, hermesDefaultLane }
}

it('keeps the pane on its thread when the caller does not choose one (Reload Agent)', async () => {
  const { replace } = harness()
  expect(await replace({})).toMatchObject({ kind: 'hermes', hermesLaneKey: DM, remoteConnectionId: 'vps' })
})

it('follows the chosen thread instead of the one the pane is leaving', async () => {
  const { replace, hermesDefaultLane } = harness()
  const spawned = await replace({ hermesLaneKey: TOPIC, newConversation: true })
  expect(spawned).toMatchObject({ hermesLaneKey: TOPIC, remoteConnectionId: 'vps' })
  expect(hermesDefaultLane).not.toHaveBeenCalled()
  expect(useAppStore.getState().workspaceState.sessions.successor?.hermesLaneKey).toBe(TOPIC)
})

it('opens a separate chat on null, without looking the default thread back up', async () => {
  const { replace, hermesDefaultLane } = harness()
  const spawned = await replace({ hermesLaneKey: null, newConversation: true })
  expect(spawned.hermesLaneKey).toBeUndefined()
  // No stored id either: a separate chat is a NEW conversation, not the
  // thread's current row resumed outside the thread.
  expect(spawned.resumeSessionId).toBeUndefined()
  expect(spawned.remoteConnectionId).toBe('vps')
  expect(hermesDefaultLane).not.toHaveBeenCalled()
  expect(useAppStore.getState().workspaceState.sessions.successor?.hermesLaneKey).toBeUndefined()
})
