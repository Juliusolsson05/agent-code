import { act, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { useUndoCloseAction } from '@renderer/workspace/hook/actions/undoClose'
import { makeRefs, sessionActionsWithSpawn, stateWriter } from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
import { freshStage } from '@renderer/workspace/dispatch/gridShape'
import type { WorkspaceState } from '@renderer/workspace/types'

// #1325 review A3 (workflow runs) and #1320 (goal loops): Undo Close resumes the same conversation (--resume) under a
// fresh session id, but its workflow runs stayed filed under the closed id in
// main, so the restored pane showed no workflow history. Restoring a pane or a
// whole project must hand each closed id's runs to its restored id.
const originalApi = window.api
afterEach(() => { window.api = originalApi })

type Writer = ReturnType<typeof stateWriter>
// The spawn is built from the writer, so a spawn can file its successor's meta
// the way production spawn does.
// `older` entries go on the stack first, below `entry`, to see whether one
// undo consumed exactly one operation.
function mount(entry: unknown, makeSpawn: (writer: Writer) => ReturnType<typeof vi.fn>, older: unknown[] = []) {
  const state: WorkspaceState = {
    tabs: [{ id: 'tab-parent', title: 'agent-code' }], activeTabId: 'tab-parent', stage: freshStage(),
    sessions: {}, pinnedSessionIds: [],
  }
  const refs = makeRefs(state)
  const writer = stateWriter(state, refs)
  for (const below of older) refs.undoStackRef.current.push(below as never)
  refs.undoStackRef.current.push(entry as never)
  const carryWorkflowRuns = vi.fn(async (_from: string, _to: string) => undefined)
  const carryOrchestrationParent = vi.fn(async (_from: string, _to: string) => undefined)
  const carryGoalLoop = vi.fn(async (_from: string, _to: string) => null)
  const controlGoalLoop = vi.fn(async (_request: { sessionId: string; action: string }) => null)
  window.api = { ...originalApi, carryWorkflowRuns, carryOrchestrationParent, carryGoalLoop, controlGoalLoop, killOwnedSession: vi.fn(async () => true) }
  const spawn = makeSpawn(writer)
  let actions!: ReturnType<typeof useUndoCloseAction>
  function Harness(): React.JSX.Element {
    actions = useUndoCloseAction(state, writer.setState, refs, sessionActionsWithSpawn(spawn), vi.fn())
    return <div />
  }
  const mounted = render(<Harness />)
  return { carryWorkflowRuns, carryOrchestrationParent, carryGoalLoop, controlGoalLoop, writer, refs, undo: () => actions.undoClose(), unmount: () => mounted.unmount() }
}

it('hands a restored pane the workflow runs of the pane it restores', async () => {
  const harness = mount({
    type: 'session', closedAt: Date.now(), sessionId: 'closed-pane',
    sessionMeta: { cwd: '/projects/agent-code', kind: 'claude', title: 'Fix the picker', projectId: 'tab-parent', joinedAt: 1 },
  }, () => vi.fn().mockResolvedValue('restored-pane'))
  await act(async () => { await harness.undo() })
  expect(harness.carryWorkflowRuns).toHaveBeenCalledWith('closed-pane', 'restored-pane')
  // #1283 item 1: and the children it closed through the orchestration MCP.
  expect(harness.carryOrchestrationParent).toHaveBeenCalledWith('closed-pane', 'restored-pane')
  harness.unmount()
})

it('hands every agent of a restored project its workflow runs, and none for one that did not come back', async () => {
  const meta = (title: string) => ({ cwd: '/projects/agent-code', kind: 'claude' as const, title, projectId: 'closed-tab', joinedAt: 1 })
  const harness = mount({
    type: 'tab', closedAt: Date.now(), tab: { id: 'closed-tab', title: 'agent-code' }, tabIndex: 0,
    sessions: [{ sessionId: 'one', meta: meta('One') }, { sessionId: 'two', meta: meta('Two') }, { sessionId: 'three', meta: meta('Three') }],
  }, () => vi.fn().mockResolvedValueOnce('new-one').mockRejectedValueOnce(new Error('spawn failed')).mockResolvedValueOnce('new-three'))
  await act(async () => { await harness.undo() })
  expect(harness.carryWorkflowRuns.mock.calls.sort()).toEqual([['one', 'new-one'], ['three', 'new-three']])
  harness.unmount()
})

// #1320: GoalLoopService keys loops by session id, so a restored pane's loop
// stayed under the closed id and the pane could neither Resume nor Stop it.
// The rule is #1287's: carry to a successor with Goal Loop tools, otherwise
// end the loop, since nothing could ever complete it. Production spawn writes
// the resolved builtInMcpDomains into the successor's meta; this spawn does
// the same with the domains each call is told to have.
function spawnWith(domainsById: Record<string, string[]>, failFor: string[] = []) {
  return (writer: Writer) => {
    const ids = Object.keys(domainsById)
    let call = 0
    return vi.fn(async (cwd: string) => {
      const id = ids[call++]
      if (failFor.includes(id)) throw new Error('spawn failed')
      writer.setState(prev => ({
        ...prev,
        sessions: { ...prev.sessions, [id]: { cwd, kind: 'claude', builtInMcpDomains: domainsById[id] } as never },
      }))
      return id
    })
  }
}
const closedPane = (sessionId: string) => ({
  type: 'session', closedAt: Date.now(), sessionId,
  sessionMeta: { cwd: '/projects/agent-code', kind: 'claude', title: 'Fix the picker', projectId: 'tab-parent', joinedAt: 1 },
})

it('hands a restored pane with Goal Loop tools the loop of the pane it restores', async () => {
  const harness = mount(closedPane('closed-pane'), spawnWith({ 'restored-pane': ['goal_loop', 'workflows'] }))
  await act(async () => { await harness.undo() })
  expect(harness.carryGoalLoop).toHaveBeenCalledWith('closed-pane', 'restored-pane')
  expect(harness.controlGoalLoop).not.toHaveBeenCalled()
  harness.unmount()
})

it('ends the loop of a restored pane that came back without Goal Loop tools', async () => {
  const harness = mount(closedPane('closed-pane'), spawnWith({ 'restored-pane': ['workflows'] }))
  await act(async () => { await harness.undo() })
  expect(harness.carryGoalLoop).not.toHaveBeenCalled()
  expect(harness.controlGoalLoop).toHaveBeenCalledWith({ sessionId: 'closed-pane', action: 'stop' })
  harness.unmount()
})

// #1331 review (a, b, c): a project that comes back only in part consumes
// its undo entry (#992's best-effort rule), so a member whose respawn failed
// can never be restored. Its loop used to stay under the dead id with no pane
// to Resume or Stop it; it is ended, like any loop no pane can reach. The
// older entry below proves the undo consumed exactly this one operation.
it('hands each agent of a restored project its loop, or ends it, including one that did not come back', async () => {
  const meta = (title: string) => ({ cwd: '/projects/agent-code', kind: 'claude' as const, title, projectId: 'closed-tab', joinedAt: 1 })
  const harness = mount({
    type: 'tab', closedAt: Date.now(), tab: { id: 'closed-tab', title: 'agent-code' }, tabIndex: 0,
    sessions: [{ sessionId: 'one', meta: meta('One') }, { sessionId: 'two', meta: meta('Two') }, { sessionId: 'three', meta: meta('Three') }],
  }, spawnWith({ 'new-one': ['goal_loop'], 'new-two': ['goal_loop'], 'new-three': [] }, ['new-two']), [closedPane('older-pane')])
  await act(async () => { await harness.undo() })
  expect(harness.carryGoalLoop.mock.calls).toEqual([['one', 'new-one']])
  expect(harness.controlGoalLoop.mock.calls.map(([request]) => request.sessionId).sort()).toEqual(['three', 'two'])
  expect(harness.refs.undoStackRef.current.length).toBe(1)
  harness.unmount()
})

// A restore that bails (its project was closed while the spawn was in
// flight) kills the successor and is judged stale: the entry is consumed, so
// nothing can ever restore that pane. #1331 review: the loop used to be left
// under the dead id; it is ended, and nothing is carried to the killed
// successor.
it('ends the loop when the restore bails and consumes the entry', async () => {
  const harness = mount(closedPane('closed-pane'), (writer: Writer) => vi.fn(async () => {
    writer.setState(prev => ({ ...prev, tabs: [] }))
    return 'restored-pane'
  }))
  await act(async () => { await harness.undo() })
  expect(harness.carryGoalLoop).not.toHaveBeenCalled()
  expect(harness.carryWorkflowRuns).not.toHaveBeenCalled()
  expect(harness.carryOrchestrationParent).not.toHaveBeenCalled()
  expect(harness.controlGoalLoop.mock.calls).toEqual([[{ sessionId: 'closed-pane', action: 'stop' }]])
  expect(harness.refs.undoStackRef.current.length).toBe(0)
  harness.unmount()
})

// A spawn failure a retry may fix keeps the entry, so the retry decides what
// happens to the loop: nothing moves now.
it('leaves the loop alone when a failed restore keeps its entry for another try', async () => {
  const harness = mount(closedPane('closed-pane'), () => vi.fn().mockRejectedValue(new Error('spawn failed')))
  await act(async () => { await harness.undo() })
  expect(harness.refs.undoStackRef.current.length).toBe(1)
  expect(harness.carryGoalLoop).not.toHaveBeenCalled()
  expect(harness.controlGoalLoop).not.toHaveBeenCalled()
  harness.unmount()
})

// #1331 review c (surviving mutant): a successor with no filed meta has no
// proven Goal Loop tools, so its loop is ended, never carried on a guess.
it('ends the loop when the successor has no filed meta to prove Goal Loop tools', async () => {
  const harness = mount(closedPane('closed-pane'), () => vi.fn().mockResolvedValue('restored-pane'))
  await act(async () => { await harness.undo() })
  expect(harness.carryGoalLoop).not.toHaveBeenCalled()
  expect(harness.controlGoalLoop).toHaveBeenCalledWith({ sessionId: 'closed-pane', action: 'stop' })
  harness.unmount()
})
