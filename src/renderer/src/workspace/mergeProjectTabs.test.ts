import { describe, expect, it } from 'vitest'

import { mergeProjectTabs, retargetTileTabsAfterMerge } from '@renderer/workspace/mergeProjectTabs'
import { collectOwnedSessionIds } from '@renderer/workspace/sessionOwnership'
import { resolveTabSessions } from '@renderer/workspace/queries'
import type { SessionMeta, TileTabsState, WorkspaceState } from '@renderer/workspace/types'

// The workspace that motivated #913, reduced: three tabs for one repository
// (two of them holding worktree agents) plus an unrelated project, with every
// kind of tab-keyed reference a merge has to carry.
function meta(cwd: string): SessionMeta {
  return { cwd, kind: 'claude' }
}

function fixture(): WorkspaceState {
  return {
    tabs: [
      { id: 'tab-b', title: 'agent-code', focusedSessionId: 'b-audit', root: { type: 'leaf', sessionId: 'b-audit' } },
      { id: 'tab-startup', title: 'startup', focusedSessionId: 'pitch', root: { type: 'leaf', sessionId: 'pitch' } },
      { id: 'tab-e', title: 'agent-code', focusedSessionId: 'e-root', root: {
        type: 'split', direction: 'vertical', ratio: 0.5,
        a: { type: 'leaf', sessionId: 'e-root' },
        b: { type: 'leaf', sessionId: 'e-grok' },
      } },
      { id: 'tab-g', title: 'agent-code', focusedSessionId: 'g-review', root: { type: 'leaf', sessionId: 'g-review' } },
    ],
    activeTabId: 'tab-g',
    dispatchMode: {
      tiled: {
        lanes: [{ selectedSessionId: 'g-review' }, { selectedSessionId: 'e-tldr' }],
        rows: [
          { length: 1, projectTabIds: ['tab-g', 'tab-e'] },
          { length: 1, projectTabId: 'tab-b' },
        ],
        focusedLane: 0,
      },
    } as unknown as WorkspaceState['dispatchMode'],
    sessions: {
      'b-audit': meta('/dev/agent-code'),
      'b-verify': meta('/dev/agent-code/.worktrees/opencode-terminal-headless'),
      pitch: meta('/dev/startup'),
      'e-root': meta('/dev/agent-code'),
      'e-grok': meta('/dev/agent-code/.worktrees/grok-package-wiring'),
      'e-tldr': meta('/dev/agent-code'),
      'g-review': meta('/dev/agent-code'),
      'g-buried': meta('/dev/agent-code'),
    },
    detachedSessions: {
      'b-verify': { sessionId: 'b-verify', surface: 'dispatch', projectTabId: 'tab-b', projectTabTitle: 'agent-code', projectTabIndex: 0, detachedAt: 10 },
      'e-tldr': { sessionId: 'e-tldr', surface: 'dispatch', projectTabId: 'tab-e', projectTabTitle: 'agent-code', projectTabIndex: 2, detachedAt: 20 },
    },
    buried: [{
      id: 'g-buried', sessionId: 'g-buried', sessionMeta: meta('/dev/agent-code'), buriedAt: 30,
      sourceTabId: 'tab-g', sourceTabTitle: 'agent-code', sourceTabIndex: 3,
    }],
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
    expect(state.tabs[1]).toBe(before.tabs[2]) // the target's tree is untouched
    expect(state.activeTabId).toBe('tab-e')

    // Grid panes of the removed tabs are now Dispatch agents of the target;
    // detached records that pointed at a removed tab follow it with the
    // target's title and NEW index.
    expect(resolveTabSessions(state, 'tab-e')).toEqual(['e-root', 'e-grok', 'b-verify', 'e-tldr', 'b-audit', 'g-review'])
    expect(state.detachedSessions['b-audit']).toEqual({
      sessionId: 'b-audit', surface: 'dispatch', projectTabId: 'tab-e', projectTabTitle: 'agent-code', projectTabIndex: 1, detachedAt: 1000,
    })
    expect(state.detachedSessions['b-verify']).toMatchObject({ projectTabId: 'tab-e', projectTabIndex: 1, detachedAt: 10 })
    // The target's OWN records moved from letter C to B when tab B left, and
    // must not keep the old letter next to the ones they were just joined by.
    expect(state.detachedSessions['e-tldr']).toMatchObject({ projectTabId: 'tab-e', projectTabIndex: 1, detachedAt: 20 })
    expect(state.buried[0]).toMatchObject({ sourceTabId: 'tab-e', sourceTabTitle: 'agent-code', sourceTabIndex: 1 })
    expect(state.pinnedSessionIds).toEqual(['e-grok'])
    // Row filters that named a removed tab name the target once; the legacy
    // single binding is folded into the array; lanes are untouched.
    const rows = (state.dispatchMode as { tiled: { rows: unknown[]; lanes: unknown[] } }).tiled
    expect(rows.rows).toEqual([{ length: 1, projectTabIds: ['tab-e'] }, { length: 1, projectTabIds: ['tab-e'] }])
    expect(rows.lanes).toEqual([{ selectedSessionId: 'g-review' }, { selectedSessionId: 'e-tldr' }])

    expect(summary).toEqual({
      targetTabId: 'tab-e', targetTitle: 'agent-code', targetIndex: 1, removedTabIds: ['tab-b', 'tab-g'],
      detachedFromGrid: ['b-audit', 'g-review'], repointedDetached: ['b-verify'], repointedBuried: ['g-buried'],
    })
    expect(resolveTabSessions(state, 'tab-startup')).toEqual(['pitch'])
  })

  it('skips a source pane with no metadata and counts a pane that already had a detached record once', () => {
    const before = fixture()
    // `phantom` is a leaf the ownership rules already treat as absent;
    // `g-review` is both a grid pane of G and, by a broken earlier save, a
    // detached record of G.
    before.tabs[3]!.root = {
      type: 'split', direction: 'horizontal', ratio: 0.5,
      a: { type: 'leaf', sessionId: 'g-review' },
      b: { type: 'leaf', sessionId: 'phantom' },
    }
    before.detachedSessions['g-review'] = {
      sessionId: 'g-review', surface: 'dispatch', projectTabId: 'tab-g', projectTabTitle: 'agent-code', projectTabIndex: 3, detachedAt: 40,
    }
    const result = mergeProjectTabs(before, { targetTabId: 'tab-e', sourceTabIds: ['tab-g'], now: 1000 })
    if (!result.ok) throw new Error(result.reason)
    expect(collectOwnedSessionIds(result.state)).toEqual(collectOwnedSessionIds(before))
    expect(result.state.detachedSessions['phantom']).toBeUndefined()
    expect(result.state.detachedSessions['g-review']).toMatchObject({ projectTabId: 'tab-e', projectTabIndex: 2, detachedAt: 40 })
    expect(result.summary.detachedFromGrid).toEqual([])
    expect(result.summary.repointedDetached).toEqual(['g-review'])
  })

  it('refuses a target among the sources, an unknown tab, and an empty selection', () => {
    const state = fixture()
    expect(mergeProjectTabs(state, { targetTabId: 'tab-e', sourceTabIds: ['tab-e', 'tab-b'], now: 1 })).toEqual({ ok: false, reason: 'target_is_source' })
    expect(mergeProjectTabs(state, { targetTabId: 'tab-e', sourceTabIds: ['tab-nope'], now: 1 })).toEqual({ ok: false, reason: 'unknown_tab' })
    expect(mergeProjectTabs(state, { targetTabId: 'tab-nope', sourceTabIds: ['tab-b'], now: 1 })).toEqual({ ok: false, reason: 'unknown_tab' })
    expect(mergeProjectTabs(state, { targetTabId: 'tab-e', sourceTabIds: [], now: 1 })).toEqual({ ok: false, reason: 'nothing_to_merge' })
  })
})

describe('retargetTileTabsAfterMerge', () => {
  const tiled: TileTabsState = { tabIds: ['tab-b', 'tab-e', 'tab-g'], focusedTabId: 'tab-g', direction: 'vertical', ratios: [0.2, 0.5, 0.3] }

  it('drops merged tabs, moves focus to the target and keeps the surviving ratios aligned', () => {
    expect(retargetTileTabsAfterMerge(tiled, ['tab-g'], 'tab-e')).toMatchObject({ tabIds: ['tab-b', 'tab-e'], focusedTabId: 'tab-e' })
    const ratios = retargetTileTabsAfterMerge(tiled, ['tab-g'], 'tab-e')!.ratios
    expect(ratios[0]! / ratios[1]!).toBeCloseTo(0.4)
  })

  it('gives a tiled source\'s slot to a target that was not tiled, so the kept tab stays on screen', () => {
    const twoTiled: TileTabsState = { tabIds: ['tab-b', 'tab-g'], focusedTabId: 'tab-g', direction: 'vertical', ratios: [0.3, 0.7] }
    expect(retargetTileTabsAfterMerge(twoTiled, ['tab-g'], 'tab-e')).toMatchObject({ tabIds: ['tab-b', 'tab-e'], focusedTabId: 'tab-e', ratios: [0.3, 0.7] })
    // Two tiled sources into an untiled target: one slot, the other leaves.
    expect(retargetTileTabsAfterMerge(tiled, ['tab-b', 'tab-g'], 'tab-startup')).toMatchObject({ tabIds: ['tab-startup', 'tab-e'], focusedTabId: 'tab-startup' })
  })

  it('exits tiled tabs when fewer than two remain, and leaves an absent layout absent', () => {
    expect(retargetTileTabsAfterMerge(tiled, ['tab-b', 'tab-g'], 'tab-e')).toBeNull()
    expect(retargetTileTabsAfterMerge(null, ['tab-b'], 'tab-e')).toBeNull()
  })
})
