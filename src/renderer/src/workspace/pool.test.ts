import { describe, expect, it } from 'vitest'

import {
  fileSessionInProject,
  inheritedMembership,
  workspaceWithoutSessions,
} from '@renderer/workspace/pool'
import { resolveTabSessions } from '@renderer/workspace/queries'
import { collectUnownedSessionIds } from '@renderer/workspace/sessionOwnership'
import type { WorkspaceState } from '@renderer/workspace/types'

// pool.ts is the ONE place a session enters or leaves a project (#992). Every
// close path (session, Close Tab, bulk, reload-all's failures, kill) commits
// through `workspaceWithoutSessions`, and every spawn files through
// `fileSessionInProject`. The action suites exercise them end to end; this file
// pins the invariants directly, because they are what replaced the tile tree's
// structural guarantees and a regression here is silent everywhere else:
//
//   - no row ever names a project that does not exist (autosave would drop it,
//     leaving a backend running with no row);
//   - no project ever lists zero sessions (a phantom tab);
//   - no lane or pin ever points at a removed session;
//   - the user's STAGE SHAPE never changes because agents closed (#681).

function workspace(): WorkspaceState {
  return {
    tabs: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }],
    activeTabId: 'b',
    sessions: {
      a1: { cwd: '/a', kind: 'claude', projectId: 'a', joinedAt: 0 },
      b1: { cwd: '/b', kind: 'claude', projectId: 'b', joinedAt: 0 },
      b2: { cwd: '/b', kind: 'codex', projectId: 'b', joinedAt: 5 },
      c1: { cwd: '/c', kind: 'terminal', projectId: 'c', joinedAt: 0 },
    },
    stage: {
      lanes: [{ selectedSessionId: 'b1' }, { selectedSessionId: 'b2' }, {}, { selectedSessionId: 'b1' }],
      rows: [{ length: 2 }, { length: 2 }],
      focusedLane: 1,
    },
    pinnedSessionIds: ['b1', 'c1'],
  }
}

function expectCoherent(state: WorkspaceState): void {
  expect(collectUnownedSessionIds(state), 'every row names a live project').toEqual([])
  for (const tab of state.tabs) {
    expect(resolveTabSessions(state, tab.id).length, `project ${tab.id} lists a session`).toBeGreaterThan(0)
  }
  for (const lane of state.stage.lanes) {
    if (lane.selectedSessionId !== undefined) expect(state.sessions[lane.selectedSessionId]).toBeDefined()
  }
  for (const pinned of state.pinnedSessionIds) expect(state.sessions[pinned]).toBeDefined()
}

describe('workspaceWithoutSessions', () => {
  it('removes a row, empties EVERY lane that showed it, drops its pin, and keeps the stage shape', () => {
    const prev = workspace()
    const next = workspaceWithoutSessions(prev, ['b1'])

    expect(Object.keys(next.sessions)).toEqual(['a1', 'b2', 'c1'])
    // b1 was mirrored in lanes 0 and 3: both go empty. Neither is refilled with
    // a neighbour and neither is removed — four lanes in two rows, still.
    expect(next.stage.lanes).toEqual([{}, { selectedSessionId: 'b2' }, {}, {}])
    expect(next.stage.rows).toBe(prev.stage.rows)
    expect(next.stage.focusedLane).toBe(1)
    expect(next.pinnedSessionIds).toEqual(['c1'])
    // Project B still holds b2, so it stays, and stays active.
    expect(next.tabs).toBe(prev.tabs)
    expect(next.activeTabId).toBe('b')
    expectCoherent(next)
  })

  it('removes a project with its LAST session and moves the active project to the previous neighbour', () => {
    const next = workspaceWithoutSessions(workspace(), ['b1', 'b2'])

    expect(next.tabs.map(tab => tab.id)).toEqual(['a', 'c'])
    // The cursor trails a deletion: A, not C.
    expect(next.activeTabId).toBe('a')
    expectCoherent(next)
  })

  it('falls forward to the next project when the removed one was first', () => {
    const prev = { ...workspace(), activeTabId: 'a' }
    const next = workspaceWithoutSessions(prev, ['a1'])

    expect(next.tabs.map(tab => tab.id)).toEqual(['b', 'c'])
    expect(next.activeTabId).toBe('b')
  })

  it('does not move the active project when a BACKGROUND project is removed', () => {
    // A close issued from Agent Activity, Close Old Agents or automation must
    // not yank the user to another project.
    const next = workspaceWithoutSessions(workspace(), ['c1'])

    expect(next.tabs.map(tab => tab.id)).toEqual(['a', 'b'])
    expect(next.activeTabId).toBe('b')
    expectCoherent(next)
  })

  it('leaves an empty workspace with no active project rather than a dangling id', () => {
    const next = workspaceWithoutSessions(workspace(), ['a1', 'b1', 'b2', 'c1'])

    expect(next.tabs).toEqual([])
    expect(next.sessions).toEqual({})
    expect(next.activeTabId).toBe('')
    expect(next.pinnedSessionIds).toEqual([])
    expect(next.stage.lanes).toEqual([{}, {}, {}, {}])
  })

  it('returns the SAME state when nothing it was asked to remove exists', () => {
    // Identity matters: every close path calls this inside a setState updater,
    // and a fresh object for a no-op re-renders every lane in the workspace.
    const prev = workspace()
    expect(workspaceWithoutSessions(prev, ['gone', 'also-gone'])).toBe(prev)
    expect(workspaceWithoutSessions(prev, [])).toBe(prev)
  })

  describe('alsoIfEmpty', () => {
    it('removes a named project that is already empty', () => {
      // Close Tab's last commit can find its project's final session already
      // gone (it exited on its own mid-operation). No session is left to take
      // the project with it, so the project is named explicitly.
      const prev = workspace()
      delete prev.sessions.c1
      prev.pinnedSessionIds = ['b1']
      const next = workspaceWithoutSessions(prev, [], ['c'])

      expect(next.tabs.map(tab => tab.id)).toEqual(['a', 'b'])
      expectCoherent(next)
    })

    it('is NEVER a force: a named project that still holds a session survives', () => {
      // Removing it would leave b2 naming a project that does not exist — an
      // unowned row the next autosave drops while its backend keeps running.
      // This function deletes rows, never processes.
      const prev = workspace()
      const next = workspaceWithoutSessions(prev, ['b1'], ['b'])

      expect(next.tabs.map(tab => tab.id)).toEqual(['a', 'b', 'c'])
      expect(next.sessions.b2).toBeDefined()
      expectCoherent(next)
    })
  })

  it('does not sweep a project that is empty for an unrelated reason', () => {
    // ⌘T creates the project and its first agent in two steps. A close landing
    // between them must not delete the project the user is mid-way through
    // creating: only projects that HELD a removed session are candidates.
    const prev = workspace()
    prev.tabs = [...prev.tabs, { id: 'pending', title: 'Pending' }]
    const next = workspaceWithoutSessions(prev, ['a1'])

    expect(next.tabs.map(tab => tab.id)).toEqual(['b', 'c', 'pending'])
  })
})

describe('fileSessionInProject', () => {
  it('stamps membership and an order key without touching anything else on the row', () => {
    const sessions = { s: { cwd: '/x', kind: 'codex' as const, title: 'Keep me' } }
    const filed = fileSessionInProject(sessions, 's', 'p', 42)

    expect(filed.s).toEqual({ cwd: '/x', kind: 'codex', title: 'Keep me', projectId: 'p', joinedAt: 42 })
    expect(sessions.s).not.toHaveProperty('projectId')
  })

  it('defaults the order key to now, so a new session joins at the END of its project', () => {
    const before = Date.now()
    const filed = fileSessionInProject({ s: { cwd: '/x', kind: 'claude' } }, 's', 'p')
    expect(filed.s!.joinedAt).toBeGreaterThanOrEqual(before)
  })

  it('cannot resurrect a row that a racing kill already removed', () => {
    // Spawn awaits main; the user can close the pane meanwhile. Filing must
    // not re-create the row from nothing.
    const sessions = {}
    expect(fileSessionInProject(sessions, 'gone', 'p')).toBe(sessions)
  })
})

describe('inheritedMembership', () => {
  it('hands a successor its predecessor\'s project AND position', () => {
    // A provider switch or reload replaces the row under a new id. Re-stamping
    // `joinedAt` would send the agent to the bottom of its project's list
    // every time the user reloads it.
    expect(inheritedMembership({ cwd: '/x', kind: 'claude', projectId: 'p', joinedAt: 7 }))
      .toEqual({ projectId: 'p', joinedAt: 7 })
  })

  it('inherits nothing from an unknown or unfiled predecessor', () => {
    // Empty, not a guess: the caller's own filing — or the ownership prune —
    // decides, rather than a stale or invented project.
    expect(inheritedMembership(undefined)).toEqual({})
    expect(inheritedMembership({ cwd: '/x', kind: 'claude' })).toEqual({})
  })
})
