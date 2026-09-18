import { act } from '@testing-library/react'
import { expect, it } from 'vitest'
import { mountPaneActions } from './testing/paneActionsHarness'
import { resolveTabSessions } from '@renderer/workspace/queries'
import type { WorkspaceState } from '@renderer/workspace/types'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'

function state(): WorkspaceState {
  return { activeTabId: 'project', stage: oneLaneStage('anchor'), pinnedSessionIds: [],  
    tabs: [{ id: 'project', title: 'Project' }],
    sessions: { anchor: { kind: 'claude', cwd: '/project', projectId: 'project', joinedAt: 0 } } }
}

// "Leaves the grid intact" was this suite's recurring assertion: a control-plane
// create parked the new agent in the detached bucket and must not have touched
// the tab's tile tree. The tree is gone (#992), so that half has nothing left
// to assert. What a create DOES touch is pinned instead, precisely: it files
// the agent under the requested project, and — unless the caller passes
// `selectCreated: false` (last case below) — shows it in the FOCUSED lane and
// nowhere else.
//
// KNOWN AND DELIBERATE, NOT ENDORSED: that default displaces the lane's current
// occupant (`anchor` here). Stage 4 of the plan replaces it with "context
// places": never displace an occupied lane, prefer an empty one. These
// assertions will change with it; they pin today's behavior so the change is a
// visible diff rather than a silent one.
it('returns the exact created ID, files it under the project, and shows it in the focused lane only', async () => {
  const initial = state()
  const harness = mountPaneActions(initial, { spawnSessionId: 'exact-created-agent' })
  await act(async () => {
    expect(await harness.actions.createDetachedDispatchAgent({ kind: 'codex' }, { tabId: 'project', anchorSessionId: 'anchor' }))
      .toBe('exact-created-agent')
  })
  expect(harness.getState().sessions['exact-created-agent']).toMatchObject({ projectId: 'project', joinedAt: expect.any(Number) })
  // Appended: a new agent never jumps the queue in its project's index.
  expect(resolveTabSessions(harness.getState(), 'project')).toEqual(['anchor', 'exact-created-agent'])
  expect(harness.getState().stage).toEqual({ ...initial.stage, lanes: [{ selectedSessionId: 'exact-created-agent' }] })
  // Displaced from the lane, NOT from the pool: `anchor` is still a member.
  expect(harness.getState().sessions.anchor).toEqual(initial.sessions.anchor)
  expect(harness.spawn).toHaveBeenCalledTimes(1)
  harness.mounted.unmount()
})


it('keeps native continuation cwd and target project separate from focus', async () => {
  const initial = state()
  const harness = mountPaneActions(initial, { spawnSessionId: 'resumed-agent' })
  await act(async () => {
    expect(await harness.actions.createDetachedSession({ kind: 'opencode', providerRuntime: 'terminal' },
      { tabId: 'project', anchorSessionId: 'anchor' }, { cwd: '/native-worktree', resumeSessionId: 'ses_native', builtInMcpOverrides: { orchestration: true } }))
      .toBe('resumed-agent')
  })
  expect(harness.spawn).toHaveBeenCalledExactlyOnceWith('/native-worktree', expect.objectContaining({ kind: 'opencode', providerRuntime: 'terminal', resumeSessionId: 'ses_native', builtInMcpOverrides: { orchestration: true } }))
  // Filed under the TARGET project even though its cwd is somewhere else
  // entirely: a project is a label the caller chose, not a directory match.
  expect(harness.getState().sessions['resumed-agent']).toMatchObject({ projectId: 'project', cwd: '/native-worktree' })
  expect(harness.getState().stage).toEqual({ ...initial.stage, lanes: [{ selectedSessionId: 'resumed-agent' }] })
  harness.mounted.unmount()
})

// Reproduce the operator's two-lane creation observation through the real
// placement owner: being filed in the pool must not imply a preserved lane
// selection — `selectCreated` is the only thing that decides it.
it.each([true, false])('creation selectCreated=%s preserves or replaces the captured lane explicitly', async selectCreated => {
  const initial = state()
  initial.sessions.hermes = { kind: 'codex', cwd: '/other', projectId: 'other', joinedAt: 0 }
  initial.tabs.push({ id: 'other', title: 'Other' })
  initial.activeTabId = 'other'
  initial.stage = {
    focusedLane: 1, lanes: [{ selectedSessionId: 'anchor' }, { selectedSessionId: 'hermes' }],
  }
  const harness = mountPaneActions(initial, { spawnSessionId: 'new-agent' })
  await act(async () => {
    await harness.actions.createDetachedSession({ kind: 'codex' },
      { tabId: 'project', anchorSessionId: 'anchor' }, undefined, { selectCreated })
  })
  const next = harness.getState()
  expect(next.activeTabId).toBe(selectCreated ? 'project' : 'other')
  expect(next.stage.lanes.map(lane => lane.selectedSessionId))
    .toEqual(['anchor', selectCreated ? 'new-agent' : 'hermes'])
  expect(next.sessions.hermes).toEqual(initial.sessions.hermes)
  expect(next.sessions['new-agent']?.projectId).toBe('project')
  expect(harness.sessionActions.killSession).not.toHaveBeenCalled()
  harness.mounted.unmount()
})
