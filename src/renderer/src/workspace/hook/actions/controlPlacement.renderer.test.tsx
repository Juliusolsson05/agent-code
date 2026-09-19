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
// `selectCreated: false` — never moves a lane that already shows a session.
//
// The lane default was briefly "replace the focused lane's occupant" and was
// pinned here as KNOWN NOT ENDORSED. Context-places (#992 §4.3, stage 4)
// replaced it: an occupied lane is never displaced, so a control create lands
// in the pool with nothing on screen moving. The fill case has its own test
// below with an empty focused lane.
it('returns the exact created ID, files it under the project, and moves nothing on screen', async () => {
  const initial = state()
  const harness = mountPaneActions(initial, { spawnSessionId: 'exact-created-agent' })
  await act(async () => {
    expect(await harness.actions.createDetachedDispatchAgent({ kind: 'codex' }, { tabId: 'project', anchorSessionId: 'anchor' }))
      .toBe('exact-created-agent')
  })
  expect(harness.getState().sessions['exact-created-agent']).toMatchObject({ projectId: 'project', joinedAt: expect.any(Number) })
  // Appended: a new agent never jumps the queue in its project's index.
  expect(resolveTabSessions(harness.getState(), 'project')).toEqual(['anchor', 'exact-created-agent'])
  // The focused lane still shows `anchor`, by reference: not even a focus
  // move. The caller places the returned ID with an explicit lane-select.
  expect(harness.getState().stage).toBe(initial.stage)
  expect(harness.spawn).toHaveBeenCalledTimes(1)
  harness.mounted.unmount()
})

it('fills the focused lane when it is EMPTY and selectCreated is not false', async () => {
  const initial = state()
  initial.stage = { focusedLane: 0, lanes: [{}, { selectedSessionId: 'anchor' }] }
  const harness = mountPaneActions(initial, { spawnSessionId: 'exact-created-agent' })
  await act(async () => {
    expect(await harness.actions.createDetachedDispatchAgent({ kind: 'codex' }, { tabId: 'project', anchorSessionId: 'anchor' }))
      .toBe('exact-created-agent')
  })
  // Lane 0 (focused, empty) fills; lane 1 keeps `anchor`.
  expect(harness.getState().stage.lanes.map(lane => lane.selectedSessionId))
    .toEqual(['exact-created-agent', 'anchor'])
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
  // Occupied focused lane ⇒ pooled, not displacing.
  expect(harness.getState().stage).toBe(initial.stage)
  harness.mounted.unmount()
})

// Reproduce the operator's two-lane creation observation through the real
// placement owner. The focused lane is EMPTY here (the fill-eligible case):
// `selectCreated` is the only thing that decides whether the new agent takes
// it. With an occupied focused lane both values now pool — see the first case.
it.each([true, false])('creation selectCreated=%s fills or preserves the focused EMPTY lane explicitly', async selectCreated => {
  const initial = state()
  initial.sessions.hermes = { kind: 'codex', cwd: '/other', projectId: 'other', joinedAt: 0 }
  initial.tabs.push({ id: 'other', title: 'Other' })
  initial.activeTabId = 'other'
  initial.stage = {
    focusedLane: 1, lanes: [{ selectedSessionId: 'anchor' }, {}],
  }
  const harness = mountPaneActions(initial, { spawnSessionId: 'new-agent' })
  await act(async () => {
    await harness.actions.createDetachedSession({ kind: 'codex' },
      { tabId: 'project', anchorSessionId: 'anchor' }, undefined, { selectCreated })
  })
  const next = harness.getState()
  expect(next.activeTabId).toBe(selectCreated ? 'project' : 'other')
  expect(next.stage.lanes.map(lane => lane.selectedSessionId))
    .toEqual(['anchor', selectCreated ? 'new-agent' : undefined])
  expect(next.sessions['new-agent']?.projectId).toBe('project')
  expect(harness.sessionActions.killSession).not.toHaveBeenCalled()
  harness.mounted.unmount()
})
