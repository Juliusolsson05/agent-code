import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import { removeLaneFromGrid } from '@renderer/workspace/dispatch/gridShape'
import { makeRefs, mountPaneActions } from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
import {
  closeCompletedGoalAgents,
  completedGoalRows,
  hasGoalReportingAgents,
  laneIndicesToRemove,
} from '@renderer/workspace/completedGoalAgents'
import type { WorkspaceState } from '@renderer/workspace/types'
import type { TldrRecord } from '@shared/types/tldr'
import type { Entry } from '@shared/types/transcript'

// Close Completed Agents… through the REAL close executor (#1182).
//
// What these pin: the grant is the ticked rows; a row whose agent set a new
// goal, or started working, is refused at its own kill boundary; and "also
// remove their lanes" removes exactly the lanes whose agents really closed —
// found from the stage BEFORE the close, because closing blanks the lane.

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

const idle = (): SessionRuntime => ({
  ...emptyRuntime(),
  processStatus: 'started',
  inputReady: true,
  entries: [{ type: 'user' } as Entry, { type: 'assistant' } as Entry],
})
const working = (): SessionRuntime => ({ ...idle(), sessionStatus: 'running', streamPhase: 'tool-use' })

const goal = (text: string, revision = 1): TldrRecord => ({ text, revision, updatedAt: '2026-09-24T10:00:00.000Z' })
const done = (text: string, note: string, completedAt = '2026-09-24T12:00:00.000Z', revision = 2): TldrRecord => ({
  ...goal(text, revision), completedAt, completionNote: note,
})

/**
 * Three lanes and one pooled row, one project:
 *   lane 0  feat-a   goal complete, idle
 *   lane 1  feat-b   goal complete, still working
 *   lane 2  feat-c   goal set, not complete
 *   pool    feat-d   goal complete, idle, not in any lane
 */
function mountRun(options: { lanes?: WorkspaceState['stage'] } = {}) {
  const state: WorkspaceState = {
    tabs: [{ id: 'tab', title: 'repo' }],
    activeTabId: 'tab',
    stage: options.lanes ?? {
      lanes: [{ selectedSessionId: 'a' }, { selectedSessionId: 'b' }, { selectedSessionId: 'c' }],
      rows: [{ length: 3 }],
      focusedLane: 2,
    },
    sessions: {
      a: { cwd: '/repo/.worktrees/feat-a', kind: 'claude', title: 'Feature A', tldrIdentity: 'id-a', builtInMcpDomains: ['goal'], projectId: 'tab', joinedAt: 0 },
      b: { cwd: '/repo/.worktrees/feat-b', kind: 'codex', title: 'Feature B', tldrIdentity: 'id-b', builtInMcpDomains: ['goal'], projectId: 'tab', joinedAt: 1 },
      c: { cwd: '/repo/.worktrees/feat-c', kind: 'claude', title: 'Feature C', tldrIdentity: 'id-c', builtInMcpDomains: ['goal'], projectId: 'tab', joinedAt: 2 },
      d: { cwd: '/repo/.worktrees/feat-d', kind: 'claude', title: 'Feature D', tldrIdentity: 'id-d', builtInMcpDomains: ['goal'], projectId: 'tab', joinedAt: 3 },
    },
    pinnedSessionIds: [],
  }
  let goals: Record<string, TldrRecord> = {
    'id-a': done('Ship feature A.', 'PR #1 merged.', '2026-09-24T12:00:00.000Z'),
    'id-b': done('Ship feature B.', 'PR #2 merged.', '2026-09-24T13:00:00.000Z'),
    'id-c': goal('Ship feature C.'),
    'id-d': done('Ship feature D.', 'PR #4 merged.', '2026-09-24T11:00:00.000Z'),
  }
  const refs = makeRefs(state)
  refs.latestRuntimesRef.current = { a: idle(), b: working(), c: idle(), d: idle() }
  const showToast = vi.fn()
  const harness = mountPaneActions(state, { refs, showToast })
  // The production action is state wiring over this same pure function
  // (useDispatchActions.removeTiledLane); applying it through the harness's
  // synchronous writer keeps refs and getState coherent, as production's
  // store subscription does.
  const removeTiledLane = vi.fn((laneIndex: number) => {
    harness.setState(prev => ({ ...prev, stage: removeLaneFromGrid(prev.stage, laneIndex) ?? prev.stage }))
  })
  const run = (selection: string[], removeLanes = true) => closeCompletedGoalAgents(selection, { removeLanes }, {
    readState: () => refs.stateRef.current,
    readRuntimes: () => refs.latestRuntimesRef.current,
    readGoals: () => goals,
    closeSession: harness.actions.closeSession,
    removeTiledLane,
    showToast,
  })
  const setGoal = (identity: string, record: TldrRecord) => { goals = { ...goals, [identity]: record } }
  return { harness, refs, showToast, removeTiledLane, run, setGoal, getGoals: () => goals }
}

const killed = (): string[] => killOwnedSession.mock.calls.map(([owner]) => owner.sessionId)

describe('completed goal rows', () => {
  it('lists placed agents with a completed goal, newest completion first, marking the running one', () => {
    const { harness, refs, getGoals } = mountRun()
    const rows = completedGoalRows(harness.getState(), refs.latestRuntimesRef.current, getGoals())
    expect(rows.map(row => [row.sessionId, row.live, row.completionNote])).toEqual([
      ['b', true, 'PR #2 merged.'],
      ['a', false, 'PR #1 merged.'],
      ['d', false, 'PR #4 merged.'],
    ])
    expect(hasGoalReportingAgents(harness.getState())).toBe(true)
    expect(hasGoalReportingAgents({ ...harness.getState(), sessions: { s: { cwd: '/', kind: 'terminal', projectId: 'tab', joinedAt: 0 } } } as WorkspaceState)).toBe(false)
  })
})

describe('Close Completed Agents', () => {
  it('closes the ticked completed agents, removes only the lanes they held, and tags every kill', async () => {
    const { harness, showToast, removeTiledLane, run } = mountRun()

    // The modal would never offer `b` (running) as ticked; passing it proves
    // the flow refuses it on its own rather than trusting the selection.
    await run(['a', 'b', 'd'])

    expect(killed().sort()).toEqual(['a', 'd'])
    expect(killOwnedSession.mock.calls.map(([owner]) => (owner as { caller?: string }).caller))
      .toEqual(['bulk.close-completed-agents', 'bulk.close-completed-agents'])
    expect(Object.keys(harness.getState().sessions).sort()).toEqual(['b', 'c'])
    // Lane 0 (a) is gone; `d` never had a lane; b and c keep theirs.
    expect(removeTiledLane.mock.calls).toEqual([[0]])
    expect(harness.getState().stage.lanes.map(lane => lane.selectedSessionId)).toEqual(['b', 'c'])
    expect(showToast).toHaveBeenLastCalledWith('Closed 2 completed agents. Removed 1 lane.', 6000)
  })

  it('refuses an agent that set a new goal while the close was running, and keeps its lane', async () => {
    const { harness, removeTiledLane, run, setGoal } = mountRun({
      lanes: { lanes: [{ selectedSessionId: 'a' }, { selectedSessionId: 'd' }], rows: [{ length: 2 }], focusedLane: 0 },
    })
    // `d` is given new work between the first kill and its own.
    killOwnedSession.mockImplementation(async owner => {
      if (owner.sessionId === 'a') setGoal('id-d', goal('Start feature E.', 3))
      return true
    })

    await run(['a', 'd'])

    expect(killed()).toEqual(['a'])
    expect(harness.getState().sessions.d).toBeDefined()
    expect(removeTiledLane.mock.calls).toEqual([[0]])
    expect(harness.getState().stage.lanes.map(lane => lane.selectedSessionId)).toEqual(['d'])
  })

  it('leaves lanes in place when the user unticks lane removal', async () => {
    const { harness, removeTiledLane, run } = mountRun()
    await run(['a'], false)
    expect(killed()).toEqual(['a'])
    expect(removeTiledLane).not.toHaveBeenCalled()
    // Closing blanked the lane (#681); the slot itself stays.
    expect(harness.getState().stage.lanes.map(lane => lane.selectedSessionId)).toEqual([undefined, 'b', 'c'])
  })

  it('never removes the last lane, and does not claim it did', async () => {
    const { harness, showToast, run } = mountRun({
      lanes: { lanes: [{ selectedSessionId: 'a' }], rows: [{ length: 1 }], focusedLane: 0 },
    })
    await run(['a'])
    expect(killed()).toEqual(['a'])
    expect(harness.getState().stage.lanes).toHaveLength(1)
    expect(showToast).toHaveBeenLastCalledWith('Closed 1 completed agent.', 6000)
  })

  it('says so and closes nothing when no ticked agent still qualifies', async () => {
    const { showToast, run } = mountRun()
    expect(await run(['b', 'c'])).toBeNull()
    expect(killOwnedSession).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenLastCalledWith('No completed agents left to close.')
  })
})

describe('laneIndicesToRemove', () => {
  const before: WorkspaceState['stage'] = {
    lanes: [{ selectedSessionId: 'a' }, { selectedSessionId: 'b' }, { selectedSessionId: 'c' }],
    rows: [{ length: 3 }],
    focusedLane: 0,
  }
  const sessions = { b: {}, c: {}, x: {} } as unknown as WorkspaceState['sessions']

  it('finds lanes by their pre-close occupant, highest first, skipping ones refilled since', () => {
    const after = { sessions, stage: { ...before, lanes: [{}, { selectedSessionId: 'x' }, {}] } }
    // a's lane is empty now; b's lane was refilled with x; c did not close.
    expect(laneIndicesToRemove(before, after, ['a', 'b'])).toEqual([0])
    expect(laneIndicesToRemove(before, { sessions, stage: { ...before, lanes: [{}, {}, {}] } }, ['a', 'c'])).toEqual([2, 0])
  })

  it('removes nothing when the lane count changed during the close', () => {
    const reshaped = { sessions, stage: { lanes: [{}, {}], rows: [{ length: 2 }], focusedLane: 0 } }
    expect(laneIndicesToRemove(before, reshaped, ['a'])).toEqual([])
  })
})
