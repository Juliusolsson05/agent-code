import { act } from '@testing-library/react'
import { expect, it } from 'vitest'
import { mountPaneActions } from './testing/paneActionsHarness'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import type { WorkspaceState } from '@renderer/workspace/types'

function state(): WorkspaceState {
  return { activeTabId: 'project', dispatchMode: null, pinnedSessionIds: [], detachedSessions: {}, buried: [],
    tabs: [{ id: 'project', title: 'Project', root: { type: 'leaf', sessionId: 'anchor' }, focusedSessionId: 'anchor' }],
    sessions: { anchor: { kind: 'claude', cwd: '/project' } } }
}

it('returns the exact created ID with project affinity and leaves the grid intact', async () => {
  const initial = state()
  const harness = mountPaneActions(initial, { spawnSessionId: 'exact-created-agent' })
  await act(async () => {
    expect(await harness.actions.createDetachedDispatchAgent({ kind: 'codex' }, { tabId: 'project', anchorSessionId: 'anchor' }))
      .toBe('exact-created-agent')
  })
  expect(harness.getState().detachedSessions['exact-created-agent']).toMatchObject({ projectTabId: 'project' })
  expect(harness.getState().tabs[0].root).toEqual(initial.tabs[0].root)
  expect(harness.spawn).toHaveBeenCalledTimes(1)
  harness.mounted.unmount()
})

it('restores a buried record under its existing ID without spawning another agent', async () => {
  const initial = state()
  initial.sessions.archived = { kind: 'codex', cwd: '/project' }
  initial.buried = [{ id: 'buried-record', sessionId: 'archived', sessionMeta: initial.sessions.archived,
    buriedAt: 1, sourceTabId: 'project', sourceTabTitle: 'Project', sourceTabIndex: 0 }]
  const harness = mountPaneActions(initial)
  await act(async () => { await harness.actions.reviveBuried('buried-record') })
  expect(harness.sessionActions.ensureSessionLive).toHaveBeenCalledWith('archived', 'pane.revive-buried')
  expect(harness.getState().buried).toEqual([])
  expect(collectLeaves(harness.getState().tabs[0].root).filter(id => id === 'archived')).toHaveLength(1)
  expect(harness.spawn).not.toHaveBeenCalled()
  harness.mounted.unmount()
})
