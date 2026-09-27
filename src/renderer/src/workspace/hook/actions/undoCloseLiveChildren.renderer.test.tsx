import { act, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { useUndoCloseAction } from '@renderer/workspace/hook/actions/undoClose'
import { makeRefs, sessionActionsWithSpawn, stateWriter } from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
import { freshStage } from '@renderer/workspace/dispatch/gridShape'
import type { SessionMeta, WorkspaceState } from '@renderer/workspace/types'

// #1373: Undo Close restores a pane under a fresh session id, and its LIVE
// children (orchestration children, linked panes that stayed open) kept
// pointing at the dead id. The orchestration visibility gate compares ids, so
// the restored parent could not list, read or prompt its own children. Replace
// and Reload Agents already remap every session; Undo Close only remapped the
// rows it restored.
const originalApi = window.api
afterEach(() => { window.api = originalApi })

const meta = (title: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({ cwd: '/projects/agent-code', kind: 'claude', title, projectId: 'tab-live', joinedAt: 1, ...extra }) as SessionMeta

function mount(entry: unknown, sessions: Record<string, SessionMeta>, spawn: ReturnType<typeof vi.fn>) {
  const state: WorkspaceState = {
    tabs: [{ id: 'tab-live', title: 'live' }, { id: 'tab-parent', title: 'agent-code' }], activeTabId: 'tab-live', stage: freshStage(),
    sessions, pinnedSessionIds: [],
  }
  const refs = makeRefs(state)
  const writer = stateWriter(state, refs)
  refs.undoStackRef.current.push(entry as never)
  window.api = {
    ...originalApi, carryWorkflowRuns: vi.fn(async () => undefined), carryGoalLoop: vi.fn(async () => null),
    controlGoalLoop: vi.fn(async () => null), killOwnedSession: vi.fn(async () => true),
  } as never
  let actions!: ReturnType<typeof useUndoCloseAction>
  function Harness(): React.JSX.Element {
    actions = useUndoCloseAction(state, writer.setState, refs, sessionActionsWithSpawn(spawn), vi.fn())
    return <div />
  }
  const mounted = render(<Harness />)
  return { writer, undo: () => actions.undoClose(), unmount: () => mounted.unmount() }
}

it('points a restored pane\'s live orchestration and linked children at its new id', async () => {
  const unrelated = meta('Unrelated')
  const harness = mount(
    { type: 'session', closedAt: Date.now(), sessionId: 'closed-parent', sessionMeta: meta('Parent', { projectId: 'tab-parent' }) },
    {
      worker: meta('Worker', { orchestrationParentId: 'closed-parent', orchestrationRootId: 'closed-parent' }),
      linked: meta('Linked', { linkedParentId: 'closed-parent' }),
      // A child of ANOTHER closed parent that is still on the stack: a later
      // undo of that parent must still find it, so its pointer is kept.
      orphan: meta('Orphan', { orchestrationParentId: 'other-closed-parent', orchestrationRootId: 'other-closed-parent' }),
      unrelated,
    },
    vi.fn().mockResolvedValue('restored-parent'),
  )
  await act(async () => { await harness.undo() })
  const sessions = harness.writer.getState().sessions
  expect(sessions.worker).toMatchObject({ orchestrationParentId: 'restored-parent', orchestrationRootId: 'restored-parent' })
  expect(sessions.linked).toMatchObject({ linkedParentId: 'restored-parent' })
  expect(sessions.orphan).toMatchObject({ orchestrationParentId: 'other-closed-parent', orchestrationRootId: 'other-closed-parent' })
  // Rows no pointer touches keep their identity (no needless re-render).
  expect(sessions.unrelated).toBe(unrelated)
  harness.unmount()
})

it('points the live children of a restored project\'s members at their new ids', async () => {
  const harness = mount(
    {
      type: 'tab', closedAt: Date.now(), tab: { id: 'closed-tab', title: 'agent-code' }, tabIndex: 1,
      sessions: [{ sessionId: 'lead', meta: meta('Lead', { projectId: 'closed-tab' }) }, { sessionId: 'second', meta: meta('Second', { projectId: 'closed-tab' }) }],
    },
    {
      // Live in ANOTHER project, so the project close did not take it.
      worker: meta('Worker', { orchestrationParentId: 'second', orchestrationRootId: 'lead' }),
    },
    vi.fn().mockResolvedValueOnce('new-lead').mockResolvedValueOnce('new-second'),
  )
  await act(async () => { await harness.undo() })
  expect(harness.writer.getState().sessions.worker).toMatchObject({ orchestrationParentId: 'new-second', orchestrationRootId: 'new-lead' })
  harness.unmount()
})
