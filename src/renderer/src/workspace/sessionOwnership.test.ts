import { describe, expect, it } from 'vitest'

import {
  collectLiveProcessIds,
  collectOwnedSessionIds,
  pruneSessionOwnership,
  repairPersistedTabs,
} from '@renderer/workspace/sessionOwnership'
import type {
  SessionId,
  SessionMeta,
  TileNode,
  WorkspaceState,
} from '@renderer/workspace/types'

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

  it('restores the gate invariant: every live id is a key of sessions', () => {
    // This is the property whose absence froze the workspace — the gate
    // compares |resolvedIds| to |liveProcessIds| while resolvedIds can only
    // ever contain keys of `sessions`, so the comparison is satisfiable only
    // when liveProcessIds is a subset of those keys. Asserted directly rather
    // than restating a fixture's expected size, so it holds for any input.
    const state = makeOrphanLeafState()
    const live = collectLiveProcessIds(state)

    expect([...live].every(id =>
      Object.prototype.hasOwnProperty.call(state.sessions, id))).toBe(true)
    expect(live.has('orphan')).toBe(false)
  })

  it('does not read metadata through the prototype chain', () => {
    // A leaf id like `toString` resolves to an inherited function under a bare
    // index read, which would classify a genuine orphan as healthy and
    // reproduce the freeze on a hand-edited workspace.json.
    const state = makeOrphanLeafState()
    state.tabs[0].root = { type: 'leaf', sessionId: 'toString' }
    state.tabs[0].focusedSessionId = 'toString'

    expect([...collectLiveProcessIds(state)]).toEqual([])
  })
})

describe('collectOwnedSessionIds', () => {
  it('keeps tile leaves owned independently of the live-process set', () => {
    // Ownership and "needs a process" are different questions. A pane kind
    // that deliberately spawns nothing (extension views) narrows the live set;
    // if ownership were derived from that narrowed set, autosave would drop the
    // pane's SessionMeta and manufacture the very orphan leaf this module
    // repairs. Pinning them as separate sources keeps that impossible.
    const state = makeOrphanLeafState()
    state.sessions.orphan = { cwd: '/work/project-a', kind: 'claude' }

    expect([...collectOwnedSessionIds(state)].sort()).toEqual(['live', 'orphan'])
  })
})

describe('repairPersistedTabs', () => {
  function repair(
    state: WorkspaceState,
    sessions: Record<SessionId, SessionMeta> = { live: state.sessions.live },
  ) {
    return repairPersistedTabs({
      tabs: state.tabs,
      sessions,
      activeTabId: state.activeTabId,
      tileTabs: null,
    })
  }

  it('collapses an orphaned split into its survivor and repoints tab focus', () => {
    const result = repair(makeOrphanLeafState())

    expect(result.droppedLeafSessionIds).toEqual(['orphan'])
    expect(result.droppedTabIds).toEqual([])
    expect(result.tabs).toHaveLength(1)
    // The split is gone entirely — the survivor is promoted to root, exactly
    // as a normal pane close would have left it.
    expect(result.tabs[0].root).toEqual({ type: 'leaf', sessionId: 'live' })
    expect(result.tabs[0].focusedSessionId).toBe('live')
    expect(result.tabs[0].title).toBe('agent-code')
  })

  it('repoints focus that names a session outside this tab', () => {
    // The invariant a tab owes is "focus names a leaf I contain". Testing
    // against the sessions map instead would leave this dangling, and rehydrate
    // does not repair it either because the id resolves fine.
    const state = makeOrphanLeafState()
    state.tabs[0].focusedSessionId = 'elsewhere'

    const result = repair(state, { live: state.sessions.live, elsewhere: state.sessions.live })

    expect(result.tabs[0].focusedSessionId).toBe('live')
  })

  it('leaves healthy trees untouched', () => {
    const state = makeOrphanLeafState()
    state.sessions.orphan = { cwd: '/work/project-a', kind: 'claude' }

    const result = repair(state, state.sessions)

    expect(result.droppedLeafSessionIds).toEqual([])
    // Identity, not just equality: a healthy save must not churn the tree.
    expect(result.tabs[0]).toBe(state.tabs[0])
    expect(result.activeTabId).toBe(state.activeTabId)
  })

  it('reports one id when the same orphan occupies several leaves', () => {
    const state = makeOrphanLeafState()
    state.tabs[0].root = {
      type: 'split',
      direction: 'vertical',
      ratio: 0.5,
      a: leaf('orphan'),
      b: { type: 'split', direction: 'horizontal', ratio: 0.5, a: leaf('orphan'), b: leaf('live') },
    }

    const result = repair(state)

    expect(result.droppedLeafSessionIds).toEqual(['orphan'])
    expect(result.tabs[0].root).toEqual({ type: 'leaf', sessionId: 'live' })
  })

  it('drops a tab whose every leaf is orphaned and repoints activeTabId', () => {
    // The one destructive branch in the whole change.
    const state = makeOrphanLeafState()
    state.tabs = [
      { id: 'tabA', title: 'agent-code', root: leaf('orphan'), focusedSessionId: 'orphan' },
      { id: 'tabB', title: 'other', root: leaf('live'), focusedSessionId: 'live' },
    ]
    state.activeTabId = 'tabA'

    const result = repair(state)

    expect(result.droppedTabIds).toEqual(['tabA'])
    expect(result.tabs.map(t => t.id)).toEqual(['tabB'])
    expect(result.activeTabId).toBe('tabB')
  })

  it('drops a dead tab out of tileTabs rather than persisting a dangling id', () => {
    const state = makeOrphanLeafState()
    state.tabs = [
      { id: 'tabA', title: 'agent-code', root: leaf('orphan'), focusedSessionId: 'orphan' },
      { id: 'tabB', title: 'b', root: leaf('live'), focusedSessionId: 'live' },
      { id: 'tabC', title: 'c', root: leaf('live'), focusedSessionId: 'live' },
    ]

    const result = repairPersistedTabs({
      tabs: state.tabs,
      sessions: { live: state.sessions.live },
      activeTabId: 'tabB',
      tileTabs: {
        tabIds: ['tabA', 'tabB', 'tabC'],
        focusedTabId: 'tabA',
        direction: 'vertical',
        ratios: [0.34, 0.33, 0.33],
      },
    })

    expect(result.tileTabs?.tabIds).toEqual(['tabB', 'tabC'])
    // Focus pointed at the dropped tab, and ratios must match the new count.
    expect(result.tileTabs?.focusedTabId).toBe('tabB')
    expect(result.tileTabs?.ratios).toHaveLength(2)
  })

  it('keeps every tab when nothing was dropped', () => {
    const state = makeOrphanLeafState()
    const tileTabs = {
      tabIds: ['tabA', 'tabB'],
      focusedTabId: 'tabA',
      direction: 'vertical' as const,
      ratios: [0.5, 0.5],
    }

    const result = repairPersistedTabs({
      tabs: state.tabs,
      sessions: { live: state.sessions.live },
      activeTabId: state.activeTabId,
      tileTabs,
    })

    // Only a dropped TAB can invalidate tileTabs; a collapsed split cannot.
    expect(result.tileTabs).toBe(tileTabs)
  })
})
