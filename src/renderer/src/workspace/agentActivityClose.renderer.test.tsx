import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import { closeAgentActivitySelection } from '@renderer/workspace/agentActivityClose'
import type { AgentActivitySelection } from '@renderer/workspace/agentActivityClose'
import type { CloseConfirmationRequest } from '@renderer/workspace/closeConfirmation'
import { makeRefs, mountPaneActions } from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
import type { WorkspaceState } from '@renderer/workspace/types'

// Agent Activity's bulk close through the REAL close executor (#1170).
//
// The same guarantees Close Idle Orchestration Agents pins, for the third
// surface that shares closeGrantedSessions: the list the user confirmed is
// exactly what dies, it carries its own kill tag, it records no undo entries,
// and an agent that starts working while the dialog is open is refused at its
// kill boundary. What differs here, and is pinned below, is that the user may
// DELIBERATELY select a working agent: that one must close, because the user
// saw it working and chose it.

const killOwnedSession = vi.fn(async (_owner: { sessionId: string }) => true)
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')

beforeEach(() => {
  killOwnedSession.mockReset().mockResolvedValue(true)
  Object.defineProperty(window, 'api', { configurable: true, value: { killOwnedSession } })
})
afterEach(() => {
  vi.restoreAllMocks()
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

type ConfirmRequest = Extract<CloseConfirmationRequest, { required: true }>

const idle = (): SessionRuntime => ({ ...emptyRuntime(), processStatus: 'started', inputReady: true })
const working = (): SessionRuntime => ({ ...idle(), sessionStatus: 'running', streamPhase: 'tool-use' })

function mountFleet() {
  const state: WorkspaceState = {
    tabs: [{ id: 'tab', title: 'repo' }],
    activeTabId: 'tab',
    stage: { lanes: [{ selectedSessionId: 'lead' }], rows: [{ length: 1 }], focusedLane: 0 },
    sessions: {
      lead: { cwd: '/repo', kind: 'claude', title: 'Lead', projectId: 'tab', joinedAt: 0 },
      stale: { cwd: '/repo', kind: 'codex', projectId: 'tab', joinedAt: 1 },
      old: { cwd: '/repo', kind: 'claude', projectId: 'tab', joinedAt: 2 },
      busy: { cwd: '/repo', kind: 'codex', projectId: 'tab', joinedAt: 3 },
    },
    pinnedSessionIds: [],
  }
  const refs = makeRefs(state)
  refs.latestRuntimesRef.current = { lead: working(), stale: idle(), old: idle(), busy: working() }
  const showToast = vi.fn()
  const harness = mountPaneActions(state, { refs, showToast })
  const run = (selection: AgentActivitySelection[], confirm: (request: ConfirmRequest) => Promise<boolean>) =>
    closeAgentActivitySelection(selection, {
      readState: () => refs.stateRef.current,
      readRuntimes: () => refs.latestRuntimesRef.current,
      closeSession: harness.actions.closeSession,
      confirm,
      showToast,
    })
  return { harness, refs, showToast, run }
}

const killed = (): string[] => killOwnedSession.mock.calls.map(([owner]) => owner.sessionId)

describe('Agent Activity bulk close', () => {
  it('confirms once with the names the user saw, then closes exactly the selection', async () => {
    const { harness, refs, showToast, run } = mountFleet()
    const confirm = vi.fn(async (_request: ConfirmRequest) => true)

    await run([{ sessionId: 'stale', name: 'repo' }, { sessionId: 'old', name: 'Fix the login bug' }], confirm)

    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0]![0].targets.map(target => target.title)).toEqual(['repo', 'Fix the login bug'])
    expect(killed()).toEqual(['stale', 'old'])
    expect(killOwnedSession.mock.calls.map(([owner]) => (owner as { caller?: string }).caller))
      .toEqual(['bulk.agent-activity', 'bulk.agent-activity'])
    expect(Object.keys(harness.getState().sessions).sort()).toEqual(['busy', 'lead'])
    // A purge must not evict the user's own close history from Undo Close.
    expect(refs.undoStackRef.current.length).toBe(0)
    expect(showToast).toHaveBeenLastCalledWith('Closed 2 agents.', 6000)
  })

  it('asks even for a single idle row, because a bulk close has no undo', async () => {
    const { run } = mountFleet()
    const confirm = vi.fn(async (_request: ConfirmRequest) => false)

    const outcome = await run([{ sessionId: 'stale', name: 'repo' }], confirm)

    expect(confirm).toHaveBeenCalledOnce()
    expect(outcome).toBeNull()
    expect(killOwnedSession).not.toHaveBeenCalled()
  })

  it('closes a working agent the user chose, but refuses an idle one that started working under the dialog', async () => {
    const { harness, refs, showToast, run } = mountFleet()

    await run([{ sessionId: 'busy', name: 'busy' }, { sessionId: 'old', name: 'old' }], async request => {
      // The dialog showed `busy` as working and `old` as idle. While the user
      // reads it, `old` picks up a follow-up.
      expect(request.targets.map(target => target.live)).toEqual([true, false])
      refs.latestRuntimesRef.current = { ...refs.latestRuntimesRef.current, old: working() }
      return true
    })

    expect(killed()).toEqual(['busy'])
    expect(harness.getState().sessions.old).toBeDefined()
    expect(showToast).toHaveBeenLastCalledWith('Closed 1, 1 skipped (changed).', 6000)
  })

  it('drops a row that vanished before the dialog, so the confirmed count is the real one', async () => {
    const { harness, run } = mountFleet()
    harness.setState(state => {
      const { stale: _gone, ...sessions } = state.sessions
      return { ...state, sessions }
    })
    const confirm = vi.fn(async (_request: ConfirmRequest) => true)

    await run([{ sessionId: 'stale', name: 'repo' }, { sessionId: 'old', name: 'old' }], confirm)

    expect(confirm.mock.calls[0]![0].targets.map(target => target.sessionId)).toEqual(['old'])
    expect(killed()).toEqual(['old'])
  })
})
