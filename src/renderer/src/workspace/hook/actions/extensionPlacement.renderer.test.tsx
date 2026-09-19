import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'
import {
  makeRefs,
  mountPaneActions,
  mountUndoCloseAction,
} from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
import { resolveTabSessions } from '@renderer/workspace/queries'
import type { SessionMeta, WorkspaceState } from '@renderer/workspace/types'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'

const extensionMeta: SessionMeta = {
  kind: 'extension-view',
  cwd: '/projects/b/worktree',
  extensionViewId: 'timer.main',
  title: 'My timer',
}

function workspace(): WorkspaceState {
  return {
    tabs: [
      { id: 'tab-a', title: 'A' },
      { id: 'tab-b', title: 'B' },
    ],
    activeTabId: 'tab-a',
    sessions: {
      a: { kind: 'claude', cwd: '/projects/a', projectId: 'tab-a', joinedAt: 0 },
      b: { kind: 'terminal', cwd: '/projects/b', projectId: 'tab-b', joinedAt: 0 },
      // Named `detached` from when it sat in the detached bucket. It is an
      // ordinary pool row of project B that no lane shows; the name is kept
      // because it still says the one thing the cases below care about — this
      // agent is NOT the one on screen when the file is first read.
      detached: { kind: 'codex', cwd: '/projects/b/worktree', projectId: 'tab-b', joinedAt: 100 },
    },
    stage: oneLaneStage('a'),
    pinnedSessionIds: [],
  } as WorkspaceState
}

describe('extension view placement follows the visible command target', () => {

  // Ran twice until #992 (`it.each([false, true])`, tiled or classic Dispatch),
  // reading the new view's id back from the classic focus. There is one layout,
  // so there is one case, and the id is read from the row it filed — the lane
  // it lands in is context-places' to decide (#992 §4.3), not this test's.
  it('opens from a target in another project, filed under that project, displacing nothing', () => {
    const initial = workspace()
    initial.stage = {
      focusedLane: 1, lanes: [{ selectedSessionId: 'a' }, { selectedSessionId: 'detached' }],
    }
    const harness = mountPaneActions(initial)
    act(() => { harness.actions.openExtensionViewInPane('timer.main') })
    const state = harness.getState()
    // The new row is found by WHAT it is, not where it shows: the focused lane
    // is occupied by the target, and an occupied lane is never displaced.
    const id = Object.keys(state.sessions)
      .find(key => state.sessions[key]!.kind === 'extension-view')!
    expect(state.activeTabId).toBe('tab-b')
    // Filed under the TARGET's project, not the active one: the view opened
    // from an agent of project B, and U4 says projects are labels that follow
    // the work. `joinedAt` is a wall-clock stamp, so only its presence and its
    // order (after the row it opened from) are asserted.
    expect(state.sessions[id]).toEqual({
      kind: 'extension-view',
      cwd: '/projects/b/worktree',
      extensionViewId: 'timer.main',
      projectId: 'tab-b',
      joinedAt: expect.any(Number),
    })
    expect(resolveTabSessions(state, 'tab-b')).toEqual(['b', 'detached', id])
    expect(state.tabs).toEqual(initial.tabs)
    expect(buildVisibleDispatchRows(state).map(row => row.sessionId)).toContain(id)
    // Nothing on screen moved: the target keeps its lane, by reference.
    expect(state.stage.lanes.map(lane => lane.selectedSessionId)).toEqual(['a', 'detached'])
    expect(harness.spawn).not.toHaveBeenCalled()
    harness.mounted.unmount()
  })

  it('fills the focused lane when it is empty', () => {
    const initial = workspace()
    initial.stage = { focusedLane: 1, lanes: [{ selectedSessionId: 'a' }, {}], rows: [{ length: 2 }] }
    const harness = mountPaneActions(initial)
    act(() => { harness.actions.openExtensionViewInPane('timer.main') })
    const state = harness.getState()
    const id = state.stage.lanes[1]!.selectedSessionId!
    // With no occupant to derive from, the project is the ACTIVE one (the
    // resolver's documented fallback) — the case is about the LANE, so that is
    // what is asserted.
    expect(state.sessions[id]).toMatchObject({ kind: 'extension-view', projectId: 'tab-a' })
    expect(state.stage.lanes[0]!.selectedSessionId).toBe('a')
    harness.mounted.unmount()
  })
})

describe('extension undo restores UI identity without a provider process', () => {
  it('restores a closed view to its place in its project and consumes the undo entry', async () => {
    const initial = workspace()
    initial.stage = { lanes: [{ selectedSessionId: 'a' }], rows: [{ length: 1 }], focusedLane: 0 }
    const refs = makeRefs(initial)
    refs.undoStackRef.current.push({
      type: 'session', closedAt: Date.now(), sessionId: 'closed',
      // Membership rides on the row (#992): the entry needs no separate record
      // to say where the view lived or where in the list it sat.
      sessionMeta: { ...extensionMeta, projectId: 'tab-b', joinedAt: 50 },
    })
    // A main-process spawn of extension-view really rejects. Resolving the
    // mock would hide the poisoned-stack bug this scenario is meant to catch.
    const spawn = vi.fn().mockRejectedValue(new Error('extension views have no process'))
    const harness = mountUndoCloseAction(initial, refs, spawn)
    await act(async () => { await harness.actions.undoClose() })
    const state = harness.getState()
    // Found by ownership, not by focus: undo files the view back into the pool
    // and deliberately does NOT re-aim a lane at it (undoClose.ts explains
    // why), so there is no focus field that would name it. It used to be read
    // from the classic-Dispatch focus, which #992 removed.
    const id = Object.keys(state.sessions).find(key => !(key in initial.sessions))!
    expect(id).toBeDefined()
    // The user's lane is exactly as they left it.
    expect(state.stage).toEqual(initial.stage)
    expect(spawn).not.toHaveBeenCalled()
    expect(refs.undoStackRef.current.length).toBe(0)
    expect(state.activeTabId).toBe('tab-b')
    expect(state.sessions[id]).toEqual({ ...extensionMeta, projectId: 'tab-b', joinedAt: 50 })
    // Back in its OLD position — between `b` (0) and `detached` (100) — not
    // appended. That is the whole reason `joinedAt` is carried through undo:
    // an index that reshuffles on Undo makes the restored row hard to find at
    // exactly the moment the user is looking for it.
    expect(resolveTabSessions(state, 'tab-b')).toEqual(['b', id, 'detached'])
    expect(buildVisibleDispatchRows(state).map(row => row.sessionId)).toContain(id)
    harness.mounted.unmount()
  })

  it('restores a closed project with both of its views, in order', async () => {
    const initial = workspace()
    const refs = makeRefs(initial)
    refs.undoStackRef.current.push({
      type: 'tab', closedAt: Date.now(), tabIndex: 1,
      tab: { id: 'closed', title: 'Extensions' },
      sessions: [
        { sessionId: 'old-view', meta: { ...extensionMeta, projectId: 'closed', joinedAt: 0 } },
        { sessionId: 'old-history', meta: { ...extensionMeta, extensionViewId: 'timer.history', projectId: 'closed', joinedAt: 75 } },
      ],
    })
    const spawn = vi.fn().mockRejectedValue(new Error('extension views have no process'))
    const harness = mountUndoCloseAction(initial, refs, spawn)
    await act(async () => { await harness.actions.undoClose() })
    const state = harness.getState()
    const tab = state.tabs[1]!
    expect(spawn).not.toHaveBeenCalled()
    expect(tab.title).toBe('Extensions')
    // The project comes back under a NEW id (every restore mints ids), and
    // both rows are re-filed under it — a row still naming `closed` would be
    // unowned and dropped by the next autosave.
    expect(tab.id).not.toBe('closed')
    const restored = resolveTabSessions(state, tab.id)
    expect(restored).toHaveLength(2)
    expect(restored.map(id => state.sessions[id])).toEqual([
      { ...extensionMeta, projectId: tab.id, joinedAt: 0 },
      { ...extensionMeta, extensionViewId: 'timer.history', projectId: tab.id, joinedAt: 75 },
    ])
    expect(refs.undoStackRef.current.length).toBe(0)
    harness.mounted.unmount()
  })
})
