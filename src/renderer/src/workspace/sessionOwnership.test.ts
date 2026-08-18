import { describe, expect, it } from 'vitest'

import {
  collectLiveProcessIds,
  pruneOrphanTileLeaves,
  pruneSessionOwnership,
} from '@renderer/workspace/sessionOwnership'
import type { TileNode, WorkspaceState } from '@renderer/workspace/types'

function leaf(sessionId: string): TileNode {
  return { type: 'leaf', sessionId }
}

function makeState(): WorkspaceState {
  return {
    tabs: [
      { id: 'tabA', title: 'project-a', root: leaf('live'), focusedSessionId: 'live' },
    ],
    activeTabId: 'tabA',
    dispatchMode: {
      scope: 'project',
      focusedSessionId: 'missing',
      tiled: {
        focusedLane: 1,
        lanes: [
          { selectedSessionId: 'live' },
          { selectedSessionId: 'missing' },
        ],
      },
    },
    sessions: {
      live: { cwd: '/work/project-a', kind: 'claude' },
      missing: { cwd: '/work/project-a', kind: 'claude' },
    },
    detachedSessions: {},
    buried: [],
    pinnedSessionIds: [],
  }
}

describe('pruneSessionOwnership', () => {
  it('clears stale tiled lane ids while preserving lane shape', () => {
    const result = pruneSessionOwnership(makeState())

    expect(result.sessions).toEqual({
      live: { cwd: '/work/project-a', kind: 'claude' },
    })
    expect(result.dispatchMode?.focusedSessionId).toBeUndefined()
    expect(result.dispatchMode?.tiled?.focusedLane).toBe(1)
    expect(result.dispatchMode?.tiled?.lanes).toEqual([
      { selectedSessionId: 'live' },
      { selectedSessionId: undefined },
    ])
  })

  it('drops detached sessions whose project tab no longer exists', () => {
    const state = makeState()
    state.sessions.parked = { cwd: '/work/project-a', kind: 'codex' }
    state.sessions.ghost = { cwd: '/work/deleted-project', kind: 'claude' }
    state.detachedSessions = {
      parked: {
        sessionId: 'parked',
        surface: 'dispatch',
        projectTabId: 'tabA',
        projectTabTitle: 'project-a',
        projectTabIndex: 0,
        detachedAt: 20,
      },
      ghost: {
        sessionId: 'ghost',
        surface: 'dispatch',
        projectTabId: 'deleted-tab',
        projectTabTitle: 'deleted-project',
        projectTabIndex: 1,
        detachedAt: 10,
      },
    }
    state.dispatchMode = {
      scope: 'global',
      focusedSessionId: 'ghost',
      tiled: {
        focusedLane: 1,
        lanes: [
          { selectedSessionId: 'parked' },
          { selectedSessionId: 'ghost' },
        ],
      },
    }

    const result = pruneSessionOwnership(state)

    expect(result.sessions).toEqual({
      live: { cwd: '/work/project-a', kind: 'claude' },
      parked: { cwd: '/work/project-a', kind: 'codex' },
    })
    expect(result.detachedSessions).toEqual({
      parked: expect.objectContaining({
        sessionId: 'parked',
        projectTabId: 'tabA',
      }),
    })
    expect(result.droppedSessionIds).toEqual(expect.arrayContaining(['missing', 'ghost']))
    expect(result.dispatchMode?.focusedSessionId).toBeUndefined()
    expect(result.dispatchMode?.tiled?.lanes).toEqual([
      { selectedSessionId: 'parked' },
      { selectedSessionId: undefined },
    ])
  })

  it('collapses a production-shaped ghost pool without touching valid hidden ownership', () => {
    const state = makeState()
    for (let index = 0; index < 8; index += 1) {
      const sessionId = `parked-${index}`
      state.sessions[sessionId] = { cwd: '/work/project-a', kind: 'codex' }
      state.detachedSessions[sessionId] = {
        sessionId,
        surface: 'dispatch',
        projectTabId: 'tabA',
        projectTabTitle: 'project-a',
        projectTabIndex: 0,
        detachedAt: index,
      }
    }
    for (let index = 0; index < 82; index += 1) {
      const sessionId = `ghost-${index}`
      state.sessions[sessionId] = { cwd: `/work/deleted-${index}`, kind: 'claude' }
      state.detachedSessions[sessionId] = {
        sessionId,
        surface: 'dispatch',
        projectTabId: `deleted-tab-${index}`,
        projectTabTitle: `deleted-${index}`,
        projectTabIndex: index + 1,
        detachedAt: index,
      }
    }
    state.sessions.buried = { cwd: '/work/archive', kind: 'claude' }
    state.buried = [{
      id: 'buried',
      sessionId: 'buried',
      sessionMeta: state.sessions.buried,
      buriedAt: 1,
      sourceTabId: 'already-closed-source-tab',
      sourceTabTitle: 'archive',
      sourceTabIndex: 2,
    }]

    const result = pruneSessionOwnership(state)

    // WHY use the observed production cardinalities instead of only another
    // one-record example: the bug was initially mistaken for legitimate lazy
    // recovery because the invalid records looked individually well-formed.
    // This fixture locks in the actual distinction—five/eight/etc. is not the
    // algorithm, parent-tab reachability is—while proving an 82-record ghost
    // pool collapses to the real owned workspace in one save cycle.
    expect(Object.keys(result.sessions)).toHaveLength(10)
    expect(Object.keys(result.detachedSessions)).toHaveLength(8)
    expect(result.buried).toHaveLength(1)
    expect(result.sessions).toHaveProperty('live')
    expect(result.sessions).toHaveProperty('buried')
    expect(result.sessions).not.toHaveProperty('ghost-0')
    expect(result.sessions).not.toHaveProperty('ghost-81')
    expect(result.droppedSessionIds).toHaveLength(83)
  })
})


// Regression fixture for the "Autosave off" freeze.
//
// Recorded from a real ~/.config/agent-code/workspace.json: tab "agent-code"
// held a vertical split whose `b` leaf pointed at a session id that had no row
// in `sessions`, and the tab's focusedSessionId pointed at that same dead id.
// Every launch afterwards journalled `expectedCount 4, resolvedCount 3, ok
// false` and refused to autosave, which meant the file could never be
// repaired. The exact shape matters, so it is reproduced rather than
// paraphrased.
function makeOrphanLeafState(): WorkspaceState {
  const state = makeState()
  state.tabs = [
    {
      id: 'tabA',
      title: 'agent-code',
      root: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.5,
        a: leaf('live'),
        b: leaf('orphan'),
      },
      focusedSessionId: 'orphan',
    },
  ]
  return state
}

describe('collectLiveProcessIds', () => {
  it('excludes tile leaves that have no session metadata', () => {
    // The gate denominator must only count panes that CAN be restored.
    // Counting the orphan is what made restore completion unsatisfiable.
    expect([...collectLiveProcessIds(makeOrphanLeafState())]).toEqual(['live'])
  })

  it('still counts every leaf that does have metadata', () => {
    const state = makeOrphanLeafState()
    state.sessions.orphan = { cwd: '/work/project-a', kind: 'claude' }

    expect([...collectLiveProcessIds(state)].sort()).toEqual(['live', 'orphan'])
  })
})

describe('pruneOrphanTileLeaves', () => {
  it('collapses an orphaned split into its survivor and repoints tab focus', () => {
    const state = makeOrphanLeafState()

    const result = pruneOrphanTileLeaves(state.tabs, { live: state.sessions.live })

    expect(result.droppedLeafSessionIds).toEqual(['orphan'])
    expect(result.droppedTabIds).toEqual([])
    expect(result.tabs).toHaveLength(1)
    // The split is gone entirely — the survivor is promoted to root, exactly
    // as a normal pane close would have left it.
    expect(result.tabs[0].root).toEqual({ type: 'leaf', sessionId: 'live' })
    expect(result.tabs[0].focusedSessionId).toBe('live')
    expect(result.tabs[0].title).toBe('agent-code')
  })

  it('leaves healthy trees untouched', () => {
    const state = makeOrphanLeafState()
    state.sessions.orphan = { cwd: '/work/project-a', kind: 'claude' }

    const result = pruneOrphanTileLeaves(state.tabs, state.sessions)

    expect(result.droppedLeafSessionIds).toEqual([])
    // Identity, not just equality: a healthy save must not churn the tree.
    expect(result.tabs[0]).toBe(state.tabs[0])
  })

  it('drops a tab whose every leaf is orphaned', () => {
    const state = makeOrphanLeafState()
    state.tabs[0].root = leaf('orphan')

    const result = pruneOrphanTileLeaves(state.tabs, { live: state.sessions.live })

    expect(result.droppedTabIds).toEqual(['tabA'])
    expect(result.tabs).toEqual([])
  })

  it('closes the loop: a pruned tree makes restore completion satisfiable again', () => {
    // The end-to-end invariant. Before the fix these two numbers could never
    // agree, so `complete` was false forever and autosave stayed locked.
    const state = makeOrphanLeafState()
    const pruned = pruneOrphanTileLeaves(state.tabs, { live: state.sessions.live })
    const expectedSessions = collectLiveProcessIds({
      tabs: pruned.tabs,
      sessions: { live: state.sessions.live },
    })
    const resolvedAfterRestore = new Set(['live'])

    expect(resolvedAfterRestore.size).toBe(expectedSessions.size)
  })
})
