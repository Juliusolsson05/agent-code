import { describe, expect, it } from 'vitest'

import { freshStage } from '@renderer/workspace/dispatch/gridShape'
import type { WorkspaceState } from '@renderer/workspace/types'
import {
  activeProjectIdOfWorkspace,
  projectIdOfSession,
  projectsOfWorkspace,
  stageOfWorkspace,
} from '@renderer/workspace/workspaceStage'

// The live-selector contract. Projects and session affinity are still DERIVED
// over the v2 owners (tabs, detached records) with the same precedence the
// persisted migration asserts (workspaceShape.test.ts), until stage 3b-ii of
// #992 stores them. The stage is no longer derived at all: it is a required
// field, and `stageOfWorkspace` only normalizes it.

const TAB_A = 'tab-a'
const TAB_B = 'tab-b'

function liveState(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    tabs: [
      {
        id: TAB_A,
        title: 'app',
      },
      {
        id: TAB_B,
        title: 'service',
      },
    ],
    activeTabId: TAB_A,
    // Deliberately EMPTY although tab-a's tree focus names s-a1: the third
    // stageOfWorkspace case below asserts that nothing derives an occupant
    // from that focus any more.
    stage: freshStage(),
    sessions: {
      's-a1': { cwd: '/x/app', kind: 'claude', projectId: TAB_A, joinedAt: 0 },
      's-b1': { cwd: '/x/service', kind: 'claude', projectId: TAB_B, joinedAt: 0 },
      's-det': { cwd: '/x/service', kind: 'claude', projectId: TAB_B, joinedAt: 1 },
    },
    pinnedSessionIds: [],
    ...overrides,
  } as WorkspaceState
}

describe('stageOfWorkspace', () => {
  it('returns the stored grid unchanged when it is already shape-complete', () => {
    // A shape-complete grid (rows present) is already current, so the
    // normalizer returns the SAME reference — the identity contract
    // downstream lane memos rely on.
    const stored = {
      lanes: [{ selectedSessionId: 's-a1' }],
      rows: [{ length: 1 }],
      focusedLane: 0,
    }
    const state = liveState({ stage: stored })
    expect(stageOfWorkspace(state)).toBe(stored)
  })

  it('normalizes a stage written before the row grid into one row', () => {
    // The one job left to this selector: a stage restored from an older file
    // has no `rows`, and every reader is entitled to assume a coherent grid.
    const legacy = { lanes: [{ selectedSessionId: 's-a1' }, {}], focusedLane: 1 }
    const stage = stageOfWorkspace(liveState({ stage: legacy }))
    expect(stage.rows).toEqual([{ length: 2 }])
    expect(stage.lanes).toEqual(legacy.lanes)
    expect(stage.focusedLane).toBe(1)
  })

  it('never invents an occupant for a fresh stage', () => {
    // Until the stage became a required field this selector DERIVED a seeded
    // default for a workspace with no grid — lane 0 holding the focused pane —
    // and cached it so lane memos did not churn ("keeps a stable reference
    // for the derived default", "mints a new default when the seed changes",
    // "prefers dispatch focus in the seed"). That derivation is gone: the
    // seed is applied ONCE, by the persisted migration, and a live selector
    // that kept re-deriving one would be #681's auto-fill by another name.
    const stage = stageOfWorkspace(liveState())
    expect(stage.lanes).toEqual([{}])
    expect(stage.rows).toEqual([{ length: 1 }])
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
