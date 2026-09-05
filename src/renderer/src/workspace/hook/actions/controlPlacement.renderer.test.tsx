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

it('keeps native continuation cwd and target project separate from focus', async () => {
  const initial = state()
  const harness = mountPaneActions(initial, { spawnSessionId: 'resumed-agent' })
  await act(async () => {
    expect(await harness.actions.createDetachedSession({ kind: 'opencode', providerRuntime: 'terminal' },
      { tabId: 'project', anchorSessionId: 'anchor' }, { cwd: '/native-worktree', resumeSessionId: 'ses_native', builtInMcpDomains: ['orchestration'] }))
      .toBe('resumed-agent')
  })
  expect(harness.spawn).toHaveBeenCalledExactlyOnceWith('/native-worktree', expect.objectContaining({ kind: 'opencode', providerRuntime: 'terminal', resumeSessionId: 'ses_native', builtInMcpDomains: ['orchestration'] }))
  expect(harness.getState().detachedSessions['resumed-agent'].projectTabId).toBe('project')
  expect(harness.getState().tabs[0].root).toEqual(initial.tabs[0].root)
  harness.mounted.unmount()
})

// Reproduce the operator's two-lane creation observation through the real
// placement owner: detached membership must not imply preserved selection.
it.each([true, false])('creation selectCreated=%s preserves or replaces the captured lane explicitly', async selectCreated => {
  const initial = state()
  initial.sessions.hermes = { kind: 'codex', cwd: '/other' }
  initial.tabs.push({ id: 'other', title: 'Other', root: { type: 'leaf', sessionId: 'hermes' }, focusedSessionId: 'hermes' })
  initial.activeTabId = 'other'
  initial.dispatchMode = { scope: 'global', focusedSessionId: 'anchor', tiled: {
    focusedLane: 1, lanes: [{ selectedSessionId: 'anchor' }, { selectedSessionId: 'hermes' }],
  } }
  const harness = mountPaneActions(initial, { spawnSessionId: 'new-agent' })
  await act(async () => {
    await harness.actions.createDetachedSession({ kind: 'codex' },
      { tabId: 'project', anchorSessionId: 'anchor' }, undefined, { selectCreated })
  })
  const next = harness.getState()
  expect(next.activeTabId).toBe(selectCreated ? 'project' : 'other')
  expect(next.dispatchMode?.tiled?.lanes.map(lane => lane.selectedSessionId))
    .toEqual(['anchor', selectCreated ? 'new-agent' : 'hermes'])
  expect(next.sessions.hermes).toEqual(initial.sessions.hermes)
  expect(next.detachedSessions['new-agent'].projectTabId).toBe('project')
  expect(harness.sessionActions.killSession).not.toHaveBeenCalled()
  harness.mounted.unmount()
})
