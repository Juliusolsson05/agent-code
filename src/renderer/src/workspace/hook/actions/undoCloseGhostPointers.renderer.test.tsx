import { act, render } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { useUndoCloseAction } from '@renderer/workspace/hook/actions/undoClose'
import { makeRefs, sessionActionsWithSpawn, stateWriter } from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
import { MissingWorkspaceDirectoryError } from '@main/workspaceDirectory'
import { UNDO_CLOSE_RETENTION_MS } from '@renderer/lib/undoClose'
import { freshStage } from '@renderer/workspace/dispatch/gridShape'
import type { SessionMeta, WorkspaceState } from '@renderer/workspace/types'

// #1387: a pointer kept for a restorable parent (#1379) must not outlive the
// last chance to restore that parent.

function mount(sessions: Record<string, SessionMeta>, spawn: ReturnType<typeof vi.fn>) {
  const state: WorkspaceState = {
    tabs: [{ id: 'tab-parent', title: 'agent-code' }], activeTabId: 'tab-parent', stage: freshStage(),
    sessions, pinnedSessionIds: [],
  }
  const refs = makeRefs(state)
  const writer = stateWriter(state, refs)
  let actions!: ReturnType<typeof useUndoCloseAction>
  function Harness(): React.JSX.Element {
    actions = useUndoCloseAction(state, writer.setState, refs, sessionActionsWithSpawn(spawn), vi.fn())
    return <div />
  }
  const mounted = render(<Harness />)
  return { refs, writer, undo: () => actions.undoClose(), rerender: () => mounted.rerender(<Harness />), unmount: () => mounted.unmount() }
}

const meta = (extra: Partial<SessionMeta>): SessionMeta =>
  ({ cwd: '/projects/agent-code', kind: 'claude', projectId: 'tab-parent', joinedAt: 1, ...extra }) as SessionMeta

// Review a, round 2: ONE close operation recorded [child C, parent P]. Undo
// replays last-first: P's folder is gone, so P is consumed as stale; C then
// comes back carrying its old pointers to P. P can never return, so C must not
// keep naming it.
it('drops pointers to a group member consumed as stale from a member restored after it', async () => {
  const gone = '/projects/deleted-worktree'
  const relayed = `Error invoking remote method 'session:spawn': ${String(new MissingWorkspaceDirectoryError(gone))}`
  const spawn = vi.fn().mockRejectedValueOnce(new Error(relayed)).mockResolvedValueOnce('restored-child')
  const harness = mount({}, spawn)
  harness.refs.undoStackRef.current.push({
    type: 'group', closedAt: Date.now(),
    entries: [
      { type: 'session', closedAt: Date.now(), sessionId: 'child', sessionMeta: meta({ linkedParentId: 'parent', orchestrationParentId: 'parent', orchestrationRootId: 'parent' }) },
      { type: 'session', closedAt: Date.now(), sessionId: 'parent', sessionMeta: meta({ cwd: gone }) },
    ],
  } as never)
  await act(async () => { await harness.undo() })
  const restored = harness.writer.getState().sessions['restored-child']
  expect(restored).toBeDefined()
  expect(restored).not.toHaveProperty('linkedParentId')
  expect(restored).not.toHaveProperty('orchestrationParentId')
  expect(restored).not.toHaveProperty('orchestrationRootId')
  harness.unmount()
})

// Review a, round 3: same group, but C's spawn fails TRANSIENTLY after P was
// consumed. C goes back on the stack as a leftover; its entry metadata must no
// longer name P, or the next Undo restores C pointing at a parent that can
// never return.
it('strips pointers to a consumed member from a leftover pushed back for retry', async () => {
  const gone = '/projects/deleted-worktree'
  const relayed = `Error invoking remote method 'session:spawn': ${String(new MissingWorkspaceDirectoryError(gone))}`
  const spawn = vi.fn()
    .mockRejectedValueOnce(new Error(relayed))
    .mockRejectedValueOnce(new Error('spawn timed out'))
    .mockResolvedValueOnce('restored-child')
  const harness = mount({}, spawn)
  harness.refs.undoStackRef.current.push({
    type: 'group', closedAt: Date.now(),
    entries: [
      { type: 'session', closedAt: Date.now(), sessionId: 'child', sessionMeta: meta({ title: 'Child', linkedParentId: 'parent', orchestrationParentId: 'parent', orchestrationRootId: 'parent' }) },
      { type: 'session', closedAt: Date.now(), sessionId: 'parent', sessionMeta: meta({ cwd: gone }) },
    ],
  } as never)
  await act(async () => { await harness.undo() })
  expect(harness.refs.undoStackRef.current.length).toBe(1)
  await act(async () => { await harness.undo() })
  const restored = harness.writer.getState().sessions['restored-child']
  expect(restored).toBeDefined()
  expect(restored).not.toHaveProperty('linkedParentId')
  expect(restored).not.toHaveProperty('orchestrationParentId')
  expect(restored).not.toHaveProperty('orchestrationRootId')
  harness.unmount()
})

// Review b, round 2: the stack's expiry notification must actually reach the
// workspace (the listener registration in useUndoCloseAction), not just fire.
it('drops a live child\'s kept pointer when its parent\'s undo entry expires', async () => {
  const spy = vi.spyOn(Date, 'now')
  const start = 5_000_000_000
  spy.mockReturnValue(start)
  const harness = mount({ child: meta({ orchestrationParentId: 'parent', orchestrationRootId: 'parent' }) }, vi.fn())
  harness.refs.undoStackRef.current.push({ type: 'session', closedAt: start, sessionId: 'parent', sessionMeta: meta({}) } as never)
  spy.mockReturnValue(start + UNDO_CLOSE_RETENTION_MS + 1)
  // The next read of the stack (a render reads its length) prunes the entry.
  await act(async () => { harness.rerender(); await Promise.resolve() })
  const child = harness.writer.getState().sessions.child
  expect(child).not.toHaveProperty('orchestrationParentId')
  expect(child).not.toHaveProperty('orchestrationRootId')
  spy.mockRestore()
  harness.unmount()
})
