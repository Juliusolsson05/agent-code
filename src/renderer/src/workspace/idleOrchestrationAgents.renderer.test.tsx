import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { CloseConfirmationRequest } from '@renderer/workspace/closeConfirmation'
import { makeRefs, mountPaneActions } from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
import { closeIdleOrchestrationAgents } from '@renderer/workspace/idleOrchestrationAgents'
import type { WorkspaceState } from '@renderer/workspace/types'
import type { Entry } from '@shared/types/transcript'

// Close Idle Orchestration Agents through the REAL close executor (#960).
//
// The eligibility rule is pinned in idleOrchestrationAgents.test.ts. What only
// an end-to-end run can show is that the grant survives the executor: the list
// the user approves is exactly what dies, owned workers die before their
// coordinator, and a worker that changes while the dialog is open is refused
// at its own kill boundary rather than killed on the strength of the list.

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

function answered(overrides: Partial<SessionRuntime> = {}): SessionRuntime {
  return {
    ...emptyRuntime(),
    processStatus: 'started',
    inputReady: true,
    entries: [{ type: 'user' } as Entry, { type: 'assistant' } as Entry],
    ...overrides,
  }
}

const working = (): SessionRuntime => answered({ sessionStatus: 'running', streamPhase: 'tool-use' })

/**
 * One project. The user's lead agent is the grid root; everything else is a
 * Dispatch row:
 *   coord  finished coordinator (orchestration child of lead)
 *   worker finished, orchestration child of coord
 *   done   finished, orchestration child of lead
 *   busy   orchestration child of lead, mid tool call
 *   manual finished agent the user opened by hand
 */
function mountRun(options: { busy?: string[] } = {}) {
  const row = (sessionId: string, detachedAt: number) => ({
    sessionId,
    surface: 'dispatch' as const,
    projectTabId: 'tab',
    projectTabTitle: 'repo',
    projectTabIndex: 0,
    detachedAt,
  })
  const state: WorkspaceState = {
    tabs: [{ id: 'tab', title: 'repo', root: { type: 'leaf', sessionId: 'lead' }, focusedSessionId: 'lead' }],
    activeTabId: 'tab',
    dispatchMode: { scope: 'project', focusedSessionId: 'lead' },
    sessions: {
      lead: { cwd: '/repo', kind: 'claude', title: 'Lead' },
      coord: { cwd: '/repo', kind: 'claude', title: 'Coordinator', orchestrationParentId: 'lead', orchestrationRootId: 'lead' },
      worker: { cwd: '/repo/.worktrees/a', kind: 'codex', title: 'Worker', orchestrationParentId: 'coord', orchestrationRootId: 'lead' },
      done: { cwd: '/repo/.worktrees/b', kind: 'codex', title: 'Done', orchestrationParentId: 'lead', orchestrationRootId: 'lead' },
      busy: { cwd: '/repo/.worktrees/c', kind: 'codex', title: 'Busy', orchestrationParentId: 'lead', orchestrationRootId: 'lead' },
      manual: { cwd: '/repo', kind: 'claude', title: 'Manual' },
    },
    detachedSessions: {
      coord: row('coord', 1),
      worker: row('worker', 2),
      done: row('done', 3),
      busy: row('busy', 4),
      manual: row('manual', 5),
    },
    gridRelatedSelections: {},
    buried: [],
    pinnedSessionIds: [],
  }
  const refs = makeRefs(state)
  const busy = new Set(['busy', ...(options.busy ?? [])])
  refs.latestRuntimesRef.current = Object.fromEntries(
    Object.keys(state.sessions).map(id => [id, busy.has(id) ? working() : answered()]),
  )
  // One toast spy for the executor and the flow, as in production where both
  // report through the global toast; assertions read the flow's LAST message.
  const showToast = vi.fn()
  const harness = mountPaneActions(state, { refs, showToast })
  const run = (confirm: (request: ConfirmRequest) => Promise<boolean>) =>
    closeIdleOrchestrationAgents({
      readState: () => refs.stateRef.current,
      readRuntimes: () => refs.latestRuntimesRef.current,
      closeSession: harness.actions.closeSession,
      confirm,
      showToast,
    })
  return { harness, refs, showToast, run }
}

const killed = (): string[] => killOwnedSession.mock.calls.map(([owner]) => owner.sessionId)

describe('Close Idle Orchestration Agents', () => {
  it('confirms exactly the finished workers, then closes each worker before its coordinator', async () => {
    const { harness, refs, showToast, run } = mountRun()
    const confirm = vi.fn(async (_request: ConfirmRequest) => true)

    await run(confirm)

    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0]![0].targets.map(target => target.sessionId)).toEqual(['coord', 'worker', 'done'])
    // `worker` first: the coordinator is only judged once the worker it owns
    // is gone, otherwise the kill-boundary rule would keep it open.
    expect(killed()).toEqual(['worker', 'coord', 'done'])
    expect(Object.keys(harness.getState().sessions).sort()).toEqual(['busy', 'lead', 'manual'])
    // A purge must not evict the user's own close history from the stack.
    expect(refs.undoStackRef.current.length).toBe(0)
    expect(showToast).toHaveBeenLastCalledWith('Closed 3 idle orchestration agents.', 6000)
  })

  it('skips a worker that starts working under the dialog, and keeps its coordinator open for it', async () => {
    const { harness, refs, showToast, run } = mountRun()

    await run(async () => {
      // While the user reads the list, the coordinator hands its worker a
      // follow-up. The list still says idle; the kill boundary must not care.
      refs.latestRuntimesRef.current = { ...refs.latestRuntimesRef.current, worker: working() }
      return true
    })

    expect(killed()).toEqual(['done'])
    expect(harness.getState().sessions.worker).toBeDefined()
    expect(harness.getState().sessions.coord).toBeDefined()
    expect(showToast).toHaveBeenLastCalledWith('Closed 1, 2 skipped (changed).', 6000)
  })

  it('closes nothing when the user declines', async () => {
    const { harness, showToast, run } = mountRun()

    const outcome = await run(async () => false)

    expect(outcome).toBeNull()
    expect(killOwnedSession).not.toHaveBeenCalled()
    expect(Object.keys(harness.getState().sessions)).toHaveLength(6)
    expect(showToast).not.toHaveBeenCalled()
  })

  it('says so, and never opens the dialog, when no worker is idle', async () => {
    const { showToast, run } = mountRun({ busy: ['worker', 'done'] })
    const confirm = vi.fn(async (_request: ConfirmRequest) => true)

    await run(confirm)

    // `coord` is idle itself but coordinates a working worker, so nothing is
    // eligible and there is nothing to confirm.
    expect(confirm).not.toHaveBeenCalled()
    expect(killOwnedSession).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenLastCalledWith('No idle orchestration agents to close.')
  })
})
