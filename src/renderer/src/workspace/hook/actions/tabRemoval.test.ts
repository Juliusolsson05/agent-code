import { describe, expect, it } from 'vitest'

import { clearRemovedTabTakeovers, workspaceWithoutTab } from './tabRemoval'
import type {
  WorkspaceSetReaderMode,
  WorkspaceSetSpotlight,
} from '@renderer/workspace/hook/context'
import type {
  ReaderModeState,
  SpotlightState,
  Tab,
  WorkspaceState,
} from '@renderer/workspace/types'

// The one tab-removal tail (#153 "consistent semantics"; coverage asked for in
// #886 review round 2 N3). Both Close Tab entry points commit through it, so the
// next-active-tab rule and takeover cleanup are pinned here once rather than
// per caller.

const tab = (id: string): Tab => ({
  id, title: id.toUpperCase(),
})

function workspace(activeTabId: string): WorkspaceState {
  return {
    tabs: [tab('a'), tab('b'), tab('c'), tab('d')],
    activeTabId,
    sessions: {
      'a-root': { cwd: '/a', kind: 'claude' },
      'b-root': { cwd: '/b', kind: 'claude' },
      'b-row': { cwd: '/b', kind: 'codex', projectId: 'b', joinedAt: 1 },
      'c-root': { cwd: '/c', kind: 'claude' },
      'd-root': { cwd: '/d', kind: 'claude' },
    },
    stage: { lanes: [{ selectedSessionId: 'b-row' }, { selectedSessionId: 'a-root' }], focusedLane: 0 },
      pinnedSessionIds: [],
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

  it('removes the sessions and rows it is given and empties the lanes that showed them', () => {
    const next = workspaceWithoutTab(workspace('b'), 'b', ['b-root', 'b-row'])
    expect(Object.keys(next.sessions).sort()).toEqual(['a-root', 'c-root', 'd-root'])
    // The lane goes EMPTY — it is neither refilled with a neighbour (#681) nor
    // removed, and the lane beside it is untouched. The user shaped the stage;
    // closing a project must not reshape it. (A classic-Dispatch focus was
    // cleared here too until #992 removed the field.)
    expect(next.stage.lanes.map(lane => lane.selectedSessionId)).toEqual([undefined, 'a-root'])
    expect(next.stage.focusedLane).toBe(0)
  })
})

describe('clearRemovedTabTakeovers', () => {
  function takeovers(initial: {
    spotlight: SpotlightState | null
    readerMode: ReaderModeState | null
  }) {
    const current = { ...initial }
    const apply = <T,>(value: T | ((prev: T) => T), prev: T): T =>
      typeof value === 'function' ? (value as (prev: T) => T)(prev) : value
    const setSpotlight: WorkspaceSetSpotlight = next => { current.spotlight = apply(next, current.spotlight) }
    const setReaderMode: WorkspaceSetReaderMode = next => { current.readerMode = apply(next, current.readerMode) }
    return { current, setters: { setSpotlight, setReaderMode } }
  }

  // Tile Tabs was the third takeover cleared here until #992 deleted it.

  it('clears Spotlight and Reader that framed the removed tab', () => {
    const { current, setters } = takeovers({
      spotlight: { tabId: 'b', focusedSessionId: 'b-root' },
      readerMode: { tabId: 'b', focusedSessionId: 'b-root' },
    })
    clearRemovedTabTakeovers(setters, 'b')
    expect(current.spotlight).toBeNull()
    expect(current.readerMode).toBeNull()
  })

  it('leaves takeovers of other tabs alone', () => {
    const spotlight = { tabId: 'a', focusedSessionId: 'a-root' }
    const readerMode = { tabId: 'c', focusedSessionId: 'c-root' }
    const { current, setters } = takeovers({ spotlight, readerMode })
    clearRemovedTabTakeovers(setters, 'b')
    expect(current.spotlight).toBe(spotlight)
    expect(current.readerMode).toBe(readerMode)
  })
})
