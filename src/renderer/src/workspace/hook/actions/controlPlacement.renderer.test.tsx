import { act } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
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

// #863. The dead end this PR is about, at the point where it is felt.
//
// `createDetachedDispatchAgent` resolves a target project and then does
// `if (!tab) return null`. Before this, that return was the primary creation
// command failing with NOTHING: no toast, and — because only a successful
// spawn closes it — the placement overlay still up, with
// `NewAgentPlacementOverlay`'s `committingRef` latched true and cleared only
// by its `open` effect, so Enter and clicks were no-ops and Escape was the
// only way out. The user's report was "New Agent just stopped working".
//
// The cause (a row bound to a project that closed) is fixed in
// `workspaceWithoutSessions`, so these cases construct the stale target
// directly. That is the point: the branch is meant to be unreachable, and the
// next thing that makes it reachable must be loud.
it.each([
  {
    name: 'a lane-resolved create names the lane, because the lane is the thing the user can change',
    override: undefined,
    expected: /this lane is pointing at/,
  },
  {
    name: 'an explicitly targeted create does not, because there is no lane in the story',
    override: { tabId: 'ghost-project' as never, anchorSessionId: 'anchor' as never },
    expected: /could not find that project/,
  },
])('says so and gets out of the way when the target project is gone: $name', async ({ override, expected }) => {
  const initial = state()
  if (!override) {
    // The reported state exactly: an EMPTY focused lane whose row is still
    // bound to a project that closed. `resolveDispatchSpawnTarget` treats a
    // row binding as outranking the active project — correctly, since the
    // row's index offers only that project — so the binding is what resolves,
    // and it names a tab that no longer exists.
    //
    // Setting `activeTabId` to a ghost would NOT reproduce this: the focused
    // lane's occupant resolves first, so the create would quietly succeed
    // under the lane's real project and this test would pass for the wrong
    // reason.
    initial.stage = { focusedLane: 0, lanes: [{}], rows: [{ length: 1, projectTabIds: ['ghost-project' as never] }] }
  }
  const harness = mountPaneActions(initial)

  await act(async () => {
    expect(await harness.actions.createDetachedDispatchAgent({ kind: 'codex' }, override)).toBeNull()
  })

  expect(harness.showToast).toHaveBeenCalledWith(expect.stringMatching(expected))
  // The half a toast alone did not fix: the overlay has to come down, or the
  // advice in it is advice the user cannot act on.
  expect(harness.closeNewAgentPlacement).toHaveBeenCalled()
  // And nothing was created on the way out.
  expect(harness.spawn).not.toHaveBeenCalled()
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

// #1270 / steering q22: a create whose spawn rejects used to toast the
// rejection verbatim. The fixture is the real IPC rejection recorded in the
// incident journal; the class of text it stands for can carry environment
// values or scoped MCP tokens.
it('never toasts the raw spawn rejection when a create fails', async () => {
  const recorded = (JSON.parse(readFileSync(join(import.meta.dirname,
    '../../../../../../testing/fixtures/spawn-failure/posix-spawnp-2026-09-23.json'), 'utf8')) as { reason: string }).reason
  const harness = mountPaneActions(state(), { spawn: vi.fn().mockRejectedValue(new Error(recorded)) })
  await act(async () => {
    expect(await harness.actions.createDetachedDispatchAgent({ kind: 'codex' })).toBeNull()
  })
  expect(harness.showToast).toHaveBeenCalledWith('Could not create agent: Session failed to start. Check provider setup and retry.')
  expect(JSON.stringify(vi.mocked(harness.showToast).mock.calls)).not.toContain('posix_spawnp')
  harness.mounted.unmount()
})

// #1286 review B2: the other two spawn catches in pane.ts.
it('never toasts the raw spawn rejection from splitFocused or createLinkedAgent', async () => {
  const recorded = (JSON.parse(readFileSync(join(import.meta.dirname,
    '../../../../../../testing/fixtures/spawn-failure/posix-spawnp-2026-09-23.json'), 'utf8')) as { reason: string }).reason
  const harness = mountPaneActions(state(), { spawn: vi.fn().mockRejectedValue(new Error(recorded)) })
  await act(async () => { await harness.actions.splitFocused('codex') })
  await act(async () => { await harness.actions.createLinkedAgent({ kind: 'codex' }, 'anchor' as never) })
  const calls = vi.mocked(harness.showToast).mock.calls.map(call => call[0])
  expect(calls).toEqual([
    'Could not create agent: Session failed to start. Check provider setup and retry.',
    'Could not create linked agent: Session failed to start. Check provider setup and retry.',
  ])
  harness.mounted.unmount()
})

// #1286 review C1: `spawn` already turned the rejection into a safe message
// (sessionSpawnErrorMessage). The curated ones carry the fix, so a create
// must show them; only the generic flattening hides the raw text.
it('shows the curated spawn failures a create can act on', async () => {
  const curated = [
    'Claude proxy startup failed. Restart Agent Code after rebuilding, or disable Proxy-Streamed Semantic Rendering in settings if the proxy will not start in this environment.',
    'Workspace folder is missing: /repo/.worktrees/gone',
    'codex CLI not found. Open Setup (File › Setup…) to install it or enter its path.',
  ]
  for (const message of curated) {
    const spawn = vi.fn().mockRejectedValue(new Error(message))
    const harness = mountPaneActions(state(), { spawn })
    await act(async () => {
      expect(await harness.actions.createDetachedDispatchAgent({ kind: 'codex' })).toBeNull()
    })
    // The folder named is the one this create asked for, never the error's
    // own text (#1286 review C round 2).
    const expected = message.startsWith('Workspace folder is missing: ')
      ? `Workspace folder is missing: ${spawn.mock.calls[0]![0] as string}`
      : message
    expect(harness.showToast).toHaveBeenCalledWith(`Could not create agent: ${expected}`)
    harness.mounted.unmount()
  }
})
