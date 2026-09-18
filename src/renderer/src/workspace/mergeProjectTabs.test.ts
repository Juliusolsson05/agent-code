import { describe, expect, it } from 'vitest'

import { mergeProjectTabs } from '@renderer/workspace/mergeProjectTabs'
import { collectOwnedSessionIds } from '@renderer/workspace/sessionOwnership'
import { resolveTabSessions } from '@renderer/workspace/queries'
import type { SessionMeta, WorkspaceState } from '@renderer/workspace/types'

// The workspace that motivated #913, reduced: three tabs for one repository
// (two of them holding worktree agents) plus an unrelated project, with every
// kind of tab-keyed reference a merge has to carry.
function meta(cwd: string): SessionMeta {
  return { cwd, kind: 'claude' }
}

function fixture(): WorkspaceState {
  return {
    tabs: [
      { id: 'tab-b', title: 'agent-code' },
      { id: 'tab-startup', title: 'startup' },
      { id: 'tab-e', title: 'agent-code' },
      { id: 'tab-g', title: 'agent-code' },
    ],
    activeTabId: 'tab-g',
    stage: {
      lanes: [{ selectedSessionId: 'g-review' }, { selectedSessionId: 'e-tldr' }],
      rows: [
        { length: 1, projectTabIds: ['tab-g', 'tab-e'] },
        // The legacy single binding, deliberately: a row written before
        // bindings became a set must be folded into one by the merge.
        { length: 1, projectTabId: 'tab-b' },
      ],
      focusedLane: 0,
    },
    sessions: {
      'b-audit': { ...meta('/dev/agent-code'), projectId: 'tab-b', joinedAt: 0 },
      'b-verify': { ...meta('/dev/agent-code/.worktrees/opencode-terminal-headless'), projectId: 'tab-b', joinedAt: 10 },
      pitch: { ...meta('/dev/startup'), projectId: 'tab-startup', joinedAt: 0 },
      'e-root': { ...meta('/dev/agent-code'), projectId: 'tab-e', joinedAt: 0 },
      'e-grok': { ...meta('/dev/agent-code/.worktrees/grok-package-wiring'), projectId: 'tab-e', joinedAt: 1 },
      'e-tldr': { ...meta('/dev/agent-code'), projectId: 'tab-e', joinedAt: 20 },
      'g-review': { ...meta('/dev/agent-code'), projectId: 'tab-g', joinedAt: 0 },
      // Parked agents no lane shows. (In v2 these two were `buried` records;
      // burial folded into the pool with #992, so they are ordinary rows.)
      'g-parked': { ...meta('/dev/agent-code'), projectId: 'tab-g', joinedAt: 30 },
      'e-parked': { ...meta('/dev/agent-code'), projectId: 'tab-e', joinedAt: 35 },
    },
    pinnedSessionIds: ['e-grok'],
  }
}

describe('mergeProjectTabs', () => {
  it('moves every source session under the target without losing ownership of any session', () => {
    const before = fixture()
    const result = mergeProjectTabs(before, { targetTabId: 'tab-e', sourceTabIds: ['tab-b', 'tab-g'], now: 1000 })
    if (!result.ok) throw new Error(result.reason)
    const { state, summary } = result

    // The load-bearing invariant: a session that lost its owner would be
    // deleted by the next autosave (see collectOwnedSessionIds).
    expect(collectOwnedSessionIds(state)).toEqual(collectOwnedSessionIds(before))
    expect(state.tabs.map(tab => tab.id)).toEqual(['tab-startup', 'tab-e'])
    expect(state.tabs[1]).toBe(before.tabs[2]) // the target itself is untouched
    expect(state.activeTabId).toBe('tab-e')

    // The target's own sessions keep their order and come first; the moved
    // ones are APPENDED, source projects in project order (B before G, though
    // the caller named them the same way here), each in its own index order.
    expect(resolveTabSessions(state, 'tab-e')).toEqual([
      'e-root', 'e-grok', 'e-tldr', 'e-parked',
      'b-audit', 'b-verify', 'g-review', 'g-parked',
    ])
    // Appended STRICTLY after the target's last row, whatever clock stamped it.
    expect(state.sessions['b-audit']).toMatchObject({ projectId: 'tab-e', joinedAt: 1000 })
    expect(state.sessions['g-parked']).toMatchObject({ projectId: 'tab-e', joinedAt: 1003 })
    // Nothing else about a moved session changes — no process is touched.
    expect(state.sessions['b-verify']).toEqual({
      ...before.sessions['b-verify'], projectId: 'tab-e', joinedAt: 1001,
    })
    // The target's own rows are the same objects.
    expect(state.sessions['e-tldr']).toBe(before.sessions['e-tldr'])
    expect(state.pinnedSessionIds).toEqual(['e-grok'])
    // Row filters that named a removed project name the target once; the
    // legacy single binding is folded into the array; lanes are untouched.
    expect(state.stage.rows).toEqual([{ length: 1, projectTabIds: ['tab-e'] }, { length: 1, projectTabIds: ['tab-e'] }])
    expect(state.stage.lanes).toEqual([{ selectedSessionId: 'g-review' }, { selectedSessionId: 'e-tldr' }])

    expect(summary).toEqual({
      targetTabId: 'tab-e', targetTitle: 'agent-code', targetIndex: 1, removedTabIds: ['tab-b', 'tab-g'],
      movedSessionIds: ['b-audit', 'b-verify', 'g-review', 'g-parked'],
    })
    expect(resolveTabSessions(state, 'tab-startup')).toEqual(['pitch'])
  })

  it('appends after the target s last row even when that row was stamped later than `now`', () => {
    // A clock that went backwards, or a target holding a session created a
    // moment ago: the moved sessions must still land at the END.
    const before = fixture()
    before.sessions['e-tldr'] = { ...before.sessions['e-tldr']!, joinedAt: 5_000 }
    const result = mergeProjectTabs(before, { targetTabId: 'tab-e', sourceTabIds: ['tab-g'], now: 1000 })
    if (!result.ok) throw new Error(result.reason)
    expect(resolveTabSessions(result.state, 'tab-e').slice(-2)).toEqual(['g-review', 'g-parked'])
    expect(result.state.sessions['g-review']!.joinedAt).toBeGreaterThan(5_000)
  })

  // "skips a source pane with no metadata and counts a pane that already had a
  // detached record once" lived here until #992. Both halves were about v2's
  // owner structures disagreeing — a tile leaf with no metadata, and a session
  // that was a leaf AND a detached record at once. Neither can be represented:
  // a session is a row, and a row names one project.

  it('refuses a target among the sources, an unknown tab, and an empty selection', () => {
    const state = fixture()
    expect(mergeProjectTabs(state, { targetTabId: 'tab-e', sourceTabIds: ['tab-e', 'tab-b'], now: 1 })).toEqual({ ok: false, reason: 'target_is_source' })
    expect(mergeProjectTabs(state, { targetTabId: 'tab-e', sourceTabIds: ['tab-nope'], now: 1 })).toEqual({ ok: false, reason: 'unknown_tab' })
    expect(mergeProjectTabs(state, { targetTabId: 'tab-nope', sourceTabIds: ['tab-b'], now: 1 })).toEqual({ ok: false, reason: 'unknown_tab' })
    expect(mergeProjectTabs(state, { targetTabId: 'tab-e', sourceTabIds: [], now: 1 })).toEqual({ ok: false, reason: 'nothing_to_merge' })
  })
})

