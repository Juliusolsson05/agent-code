import { describe, expect, it } from 'vitest'

import { clearRemovedTabTakeovers, workspaceWithoutTab } from './tabRemoval'
import type {
  WorkspaceSetReaderMode,
  WorkspaceSetSpotlight,
  WorkspaceSetTileTabs,
} from '@renderer/workspace/hook/context'
import type {
  ReaderModeState,
  SpotlightState,
  Tab,
  TileTabsState,
  WorkspaceState,
} from '@renderer/workspace/types'

// The one tab-removal tail (#153 "consistent semantics"; coverage asked for in
// #886 review round 2 N3). Both Close Tab entry points commit through it, so the
// next-active-tab rule and takeover cleanup are pinned here once rather than
// per caller.

const tab = (id: string): Tab => ({
  id, title: id.toUpperCase(), root: { type: 'leaf', sessionId: `${id}-root` }, focusedSessionId: `${id}-root`,
})

function workspace(activeTabId: string): WorkspaceState {
  return {
    tabs: [tab('a'), tab('b'), tab('c'), tab('d')],
    activeTabId,
    sessions: {
      'a-root': { cwd: '/a', kind: 'claude' },
      'b-root': { cwd: '/b', kind: 'claude' },
      'b-row': { cwd: '/b', kind: 'codex' },
      'c-root': { cwd: '/c', kind: 'claude' },
      'd-root': { cwd: '/d', kind: 'claude' },
    },
    detachedSessions: {
      'b-row': { sessionId: 'b-row', surface: 'dispatch', projectTabId: 'b', projectTabTitle: 'B', projectTabIndex: 1, detachedAt: 1 },
    },
    dispatchMode: {
      scope: 'global',
      focusedSessionId: 'b-row',
      tiled: { lanes: [{ selectedSessionId: 'b-row' }, { selectedSessionId: 'a-root' }], focusedLane: 0 },
    },
    gridRelatedSelections: {}, buried: [], pinnedSessionIds: [],
  }
}

describe('workspaceWithoutTab', () => {
  it('activates the previous neighbour when an active middle tab closes', () => {
    // The Close Tab command used to jump to tabs[0]. Closing the second tab
    // cannot tell the two rules apart (its previous neighbour IS the first tab),
    // so this closes the third of four: the neighbour rule picks b, the old
    // rule would pick a. A mutation check caught the weaker first version.
    const next = workspaceWithoutTab(workspace('c'), 'c', ['c-root'])
    expect(next.tabs.map(candidate => candidate.id)).toEqual(['a', 'b', 'd'])
    expect(next.activeTabId).toBe('b')
  })

  it('activates the new first tab when the active first tab closes', () => {
    expect(workspaceWithoutTab(workspace('a'), 'a', ['a-root']).activeTabId).toBe('b')
  })

  it('keeps the user on their tab when a background tab closes', () => {
    expect(workspaceWithoutTab(workspace('c'), 'b', ['b-root', 'b-row']).activeTabId).toBe('c')
  })

  it('removes the sessions and rows it is given and clears their Dispatch lanes and focus', () => {
    const next = workspaceWithoutTab(workspace('b'), 'b', ['b-root', 'b-row'])
    expect(Object.keys(next.sessions).sort()).toEqual(['a-root', 'c-root', 'd-root'])
    expect(next.detachedSessions).toEqual({})
    expect(next.dispatchMode?.focusedSessionId).toBeUndefined()
    expect(next.dispatchMode?.tiled?.lanes.map(lane => lane.selectedSessionId)).toEqual([undefined, 'a-root'])
  })
})

describe('clearRemovedTabTakeovers', () => {
  function takeovers(initial: {
    tileTabs: TileTabsState | null
    spotlight: SpotlightState | null
    readerMode: ReaderModeState | null
  }) {
    const current = { ...initial }
    const apply = <T,>(value: T | ((prev: T) => T), prev: T): T =>
      typeof value === 'function' ? (value as (prev: T) => T)(prev) : value
    const setTileTabs: WorkspaceSetTileTabs = next => { current.tileTabs = apply(next, current.tileTabs) }
    const setSpotlight: WorkspaceSetSpotlight = next => { current.spotlight = apply(next, current.spotlight) }
    const setReaderMode: WorkspaceSetReaderMode = next => { current.readerMode = apply(next, current.readerMode) }
    return { current, setters: { setTileTabs, setSpotlight, setReaderMode } }
  }

  it('drops the removed tab from Tiled Tabs and clears Spotlight and Reader that framed it', () => {
    const { current, setters } = takeovers({
      tileTabs: { tabIds: ['a', 'b', 'c'], focusedTabId: 'b', direction: 'vertical', ratios: [1, 1, 1] },
      spotlight: { tabId: 'b', focusedSessionId: 'b-root' },
      readerMode: { tabId: 'b', focusedSessionId: 'b-root' },
    })
    clearRemovedTabTakeovers(setters, 'b')
    expect(current.tileTabs).toMatchObject({ tabIds: ['a', 'c'], focusedTabId: 'a' })
    expect(current.tileTabs?.ratios).toHaveLength(2)
    expect(current.spotlight).toBeNull()
    expect(current.readerMode).toBeNull()
  })

  it('exits Tiled Tabs below two tabs and leaves takeovers of other tabs alone', () => {
    const spotlight = { tabId: 'a', focusedSessionId: 'a-root' }
    const readerMode = { tabId: 'c', focusedSessionId: 'c-root' }
    const { current, setters } = takeovers({
      tileTabs: { tabIds: ['a', 'b'], focusedTabId: 'a', direction: 'horizontal', ratios: [1, 1] },
      spotlight,
      readerMode,
    })
    clearRemovedTabTakeovers(setters, 'b')
    expect(current.tileTabs).toBeNull()
    expect(current.spotlight).toBe(spotlight)
    expect(current.readerMode).toBe(readerMode)
  })
})
