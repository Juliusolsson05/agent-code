import { act, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { useUndoCloseAction } from '@renderer/workspace/hook/actions/undoClose'
import { makeRefs, sessionActionsWithSpawn, stateWriter } from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
import { freshStage } from '@renderer/workspace/dispatch/gridShape'
import type { WorkspaceState } from '@renderer/workspace/types'

// #1325 review A3: Undo Close resumes the same conversation (--resume) under a
// fresh session id, but its workflow runs stayed filed under the closed id in
// main, so the restored pane showed no workflow history. Restoring a pane or a
// whole project must hand each closed id's runs to its restored id.
const originalApi = window.api
afterEach(() => { window.api = originalApi })

function mount(entry: unknown, spawn: ReturnType<typeof vi.fn>) {
  const state: WorkspaceState = {
    tabs: [{ id: 'tab-parent', title: 'agent-code' }], activeTabId: 'tab-parent', stage: freshStage(),
    sessions: {}, pinnedSessionIds: [],
  }
  const refs = makeRefs(state)
  const writer = stateWriter(state, refs)
  refs.undoStackRef.current.push(entry as never)
  const carryWorkflowRuns = vi.fn(async (_from: string, _to: string) => undefined)
  window.api = { ...originalApi, carryWorkflowRuns }
  let actions!: ReturnType<typeof useUndoCloseAction>
  function Harness(): React.JSX.Element {
    actions = useUndoCloseAction(state, writer.setState, refs, sessionActionsWithSpawn(spawn), vi.fn())
    return <div />
  }
  const mounted = render(<Harness />)
  return { carryWorkflowRuns, undo: () => actions.undoClose(), unmount: () => mounted.unmount() }
}

it('hands a restored pane the workflow runs of the pane it restores', async () => {
  const harness = mount({
    type: 'session', closedAt: Date.now(), sessionId: 'closed-pane',
    sessionMeta: { cwd: '/projects/agent-code', kind: 'claude', title: 'Fix the picker', projectId: 'tab-parent', joinedAt: 1 },
  }, vi.fn().mockResolvedValue('restored-pane'))
  await act(async () => { await harness.undo() })
  expect(harness.carryWorkflowRuns).toHaveBeenCalledWith('closed-pane', 'restored-pane')
  harness.unmount()
})

it('hands every agent of a restored project its workflow runs, and none for one that did not come back', async () => {
  const meta = (title: string) => ({ cwd: '/projects/agent-code', kind: 'claude' as const, title, projectId: 'closed-tab', joinedAt: 1 })
  const harness = mount({
    type: 'tab', closedAt: Date.now(), tab: { id: 'closed-tab', title: 'agent-code' }, tabIndex: 0,
    sessions: [{ sessionId: 'one', meta: meta('One') }, { sessionId: 'two', meta: meta('Two') }, { sessionId: 'three', meta: meta('Three') }],
  }, vi.fn().mockResolvedValueOnce('new-one').mockRejectedValueOnce(new Error('spawn failed')).mockResolvedValueOnce('new-three'))
  await act(async () => { await harness.undo() })
  expect(harness.carryWorkflowRuns.mock.calls.sort()).toEqual([['one', 'new-one'], ['three', 'new-three']])
  harness.unmount()
})
