import { describe, expect, it } from 'vitest'

import type { WorkspaceState } from '@renderer/workspace/types'
import {
  activeProjectIdOfWorkspace,
  projectIdOfSession,
  projectsOfWorkspace,
  stageOfWorkspace,
} from '@renderer/workspace/workspaceStage'

// The live-derivation contract (stage 2): the v3 views are derived over the
// still-stored v2 state with the SAME precedence the persisted migration
// asserts (workspaceShape.test.ts). These tests pin the derivation seams —
// seeded default, reference stability, affinity — not the precedence table
// itself.

const TAB_A = 'tab-a'
const TAB_B = 'tab-b'

function liveState(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    tabs: [
      {
        id: TAB_A,
        title: 'app',
        root: { type: 'leaf', sessionId: 's-a1' },
        focusedSessionId: 's-a1',
      },
      {
        id: TAB_B,
        title: 'service',
        root: { type: 'leaf', sessionId: 's-b1' },
        focusedSessionId: 's-b1',
      },
    ],
    activeTabId: TAB_A,
    dispatchMode: null,
    sessions: {
      's-a1': { cwd: '/x/app', kind: 'claude' },
      's-b1': { cwd: '/x/service', kind: 'claude' },
      's-det': { cwd: '/x/service', kind: 'claude' },
    },
    detachedSessions: {
      's-det': {
        sessionId: 's-det',
        surface: 'dispatch',
        projectTabId: TAB_B,
        projectTabTitle: 'service',
        projectTabIndex: 1,
        detachedAt: 1,
      },
    },
    buried: [],
    pinnedSessionIds: [],
    ...overrides,
  } as WorkspaceState
}

describe('stageOfWorkspace', () => {
  it('returns the stored grid unchanged when one exists', () => {
    // A shape-complete grid (rows present) is already current, so the
    // normalizer returns the SAME tiled reference — the identity contract
    // downstream memos rely on.
    const stored = {
      lanes: [{ selectedSessionId: 's-a1' }],
      rows: [{ length: 1 }],
      focusedLane: 0,
    }
    const state = liveState({ dispatchMode: { scope: 'global', tiled: stored } })
    expect(stageOfWorkspace(state)).toBe(stored)
  })

  it('derives the seeded default for a workspace with no grid', () => {
    const state = liveState()
    const stage = stageOfWorkspace(state)
    expect(stage.lanes).toEqual([{ selectedSessionId: 's-a1' }, {}])
    expect(stage.rows).toEqual([{ length: 2 }])
    expect(stage.focusedLane).toBe(0)
  })

  it('prefers dispatch focus over the active tab focus in the seed', () => {
    const state = liveState({ dispatchMode: { scope: 'project', focusedSessionId: 's-det' } })
    expect(stageOfWorkspace(state).lanes[0]).toEqual({ selectedSessionId: 's-det' })
  })

  it('keeps a stable reference for the derived default across unrelated state changes', () => {
    const first = liveState()
    const stage1 = stageOfWorkspace(first)
    // New state object, same dispatchMode reference and same effective seed
    // (sessions map grew, unrelated). Reference stability is the contract
    // that keeps downstream lane memos from churning.
    const second = liveState({
      sessions: { ...first.sessions, 's-new': { cwd: '/x', kind: 'terminal' } },
    })
    const stage2 = stageOfWorkspace(second)
    expect(stage2).toBe(stage1)
  })

  it('mints a new default when the seed changes', () => {
    const state = liveState()
    const seededOnA = stageOfWorkspace(state)
    const switched = liveState({ activeTabId: TAB_B })
    const seededOnB = stageOfWorkspace(switched)
    expect(seededOnB).not.toBe(seededOnA)
    expect(seededOnB.lanes[0]).toEqual({ selectedSessionId: 's-b1' })
  })
})

describe('projectsOfWorkspace / activeProjectIdOfWorkspace', () => {
  it('mints grouping-only projects from tabs and mirrors the active tab', () => {
    const state = liveState()
    expect(projectsOfWorkspace(state)).toEqual([
      { id: TAB_A, title: 'app' },
      { id: TAB_B, title: 'service' },
    ])
    expect(activeProjectIdOfWorkspace(state)).toBe(TAB_A)
  })
})

describe('projectIdOfSession', () => {
  it('follows the shared precedence: leaf, detached, active fallback', () => {
    const state = liveState()
    expect(projectIdOfSession(state, 's-a1')).toBe(TAB_A)
    expect(projectIdOfSession(state, 's-det')).toBe(TAB_B)
    // A session with no recorded affinity (post-close transient) lands in
    // the active project rather than dangling.
    expect(projectIdOfSession(state, 's-b1')).toBe(TAB_B)
  })
})
