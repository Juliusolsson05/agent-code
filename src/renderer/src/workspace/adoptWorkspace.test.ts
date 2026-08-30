import { describe, expect, it } from 'vitest'

import { adoptWorkspace } from '@renderer/workspace/adoptWorkspace'
import { collectOwnedSessionIds } from '@renderer/workspace/sessionOwnership'
import type { PersistedWorkspace } from '@renderer/workspace/persistence'
import type { SessionMeta, WorkspaceState } from '@renderer/workspace/types'

// Closing a window must not kill its agents. They stay alive in SessionManager
// and the surviving window takes over their workspace.
//
// The load-bearing test here is the first one: `collectOwnedSessionIds` drops a
// detached record whose `projectTabId` names no tab, so an adoption that moved
// sessions WITHOUT their tabs would look correct and then be deleted by the
// survivor's very next autosave.

function meta(cwd: string): SessionMeta {
  return { cwd, kind: 'claude' }
}

function survivorState(): WorkspaceState {
  return {
    tabs: [{
      id: 'tab-own',
      title: 'own-project',
      root: { type: 'leaf', sessionId: 'own-agent' },
      focusedSessionId: 'own-agent',
    }],
    activeTabId: 'tab-own',
    dispatchMode: null,
    sessions: { 'own-agent': meta('/own') },
    detachedSessions: {},
    buried: [],
    pinnedSessionIds: ['own-agent'],
  }
}

function closedWindowWorkspace(): PersistedWorkspace {
  return {
    tabs: [{
      id: 'tab-closed',
      title: 'closed-project',
      root: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.5,
        a: { type: 'leaf', sessionId: 'grid-a' },
        b: { type: 'leaf', sessionId: 'grid-b' },
      },
      focusedSessionId: 'grid-a',
    }],
    activeTabId: 'tab-closed',
    dispatchMode: null,
    sessions: {
      'grid-a': meta('/closed'),
      'grid-b': meta('/closed'),
      parked: meta('/closed'),
      entombed: meta('/closed'),
    },
    detachedSessions: {
      parked: {
        sessionId: 'parked',
        surface: 'dispatch',
        projectTabId: 'tab-closed',
        projectTabTitle: 'closed-project',
        projectTabIndex: 0,
        detachedAt: 10,
      },
    },
    buried: [{
      id: 'entombed',
      sessionId: 'entombed',
      sessionMeta: meta('/closed'),
      buriedAt: 20,
      sourceTabId: 'tab-closed',
      sourceTabTitle: 'closed-project',
      sourceTabIndex: 0,
    }],
    pinnedSessionIds: ['parked'],
    tileTabs: null,
    drafts: { 'grid-a': 'half-written prompt' },
  }
}

describe('adopting a closed window', () => {
  it('keeps adopted detached sessions owned, because their tab comes with them', () => {
    const adoption = adoptWorkspace(survivorState(), closedWindowWorkspace())
    expect(adoption.ok).toBe(true)
    if (!adoption.ok) return

    // The real assertion is not "the record is present" — it is that the
    // survivor's own ownership rules still consider it owned. A bare detached
    // record whose projectTabId named no tab would pass a presence check and
    // then be pruned on the next autosave, silently losing a live agent.
    const owned = collectOwnedSessionIds({
      tabs: adoption.state.tabs,
      sessions: adoption.state.sessions,
      detachedSessions: adoption.state.detachedSessions,
      buried: adoption.state.buried,
    })
    expect(owned.has('parked')).toBe(true)
    // Buried panes are a third ownership surface and were claimed to survive
    // without ever being exercised.
    expect(owned.has('entombed')).toBe(true)
    expect(owned.has('grid-a')).toBe(true)
    expect(owned.has('grid-b')).toBe(true)
    expect(owned.has('own-agent')).toBe(true)
  })

  it('preserves the closed window s tile arrangement', () => {
    const adoption = adoptWorkspace(survivorState(), closedWindowWorkspace())
    if (!adoption.ok) throw new Error('expected adoption')

    // Flattening the tree into Dispatch rows was the obvious reading of the
    // requirement and is not representable: `Tab.root` has no empty form. The
    // split survives verbatim, and the agents show up in Dispatch anyway
    // because buildDispatchGroups lists grid-placed sessions too.
    const adopted = adoption.state.tabs.find(tab => tab.id === 'tab-closed')
    expect(adopted?.root).toEqual(closedWindowWorkspace().tabs[0]?.root)
    expect(adoption.adoptedLeafSessionIds).toEqual(['grid-a', 'grid-b'])
    // Every adopted session needs a runtime, not just the painted ones: the
    // wake path for a parked or buried agent no-ops without one.
    expect([...adoption.adoptedSessionIds].sort())
      .toEqual(['entombed', 'grid-a', 'grid-b', 'parked'])
  })

  it('carries pins and drafts across', () => {
    const adoption = adoptWorkspace(survivorState(), closedWindowWorkspace())
    if (!adoption.ok) throw new Error('expected adoption')
    // Order matters: pinnedSessionIds IS the Pinned section's render order, and
    // the survivor's own pins were arranged more recently.
    expect(adoption.state.pinnedSessionIds).toEqual(['own-agent', 'parked'])
    expect(adoption.drafts).toEqual({ 'grid-a': 'half-written prompt' })
  })

  it('re-derives the Dispatch project ordinal for adopted records', () => {
    const adoption = adoptWorkspace(survivorState(), closedWindowWorkspace())
    if (!adoption.ok) throw new Error('expected adoption')
    // The adopted tab is appended after the survivor's own, so a stale index of
    // 0 would label its Dispatch rows with the survivor's project letter.
    expect(adoption.state.detachedSessions.parked?.projectTabIndex).toBe(1)
  })

  it('leaves the survivor s own workspace untouched', () => {
    const before = survivorState()
    const adoption = adoptWorkspace(before, closedWindowWorkspace())
    if (!adoption.ok) throw new Error('expected adoption')
    expect(adoption.state.tabs[0]).toEqual(before.tabs[0])
    expect(adoption.state.sessions['own-agent']).toEqual(before.sessions['own-agent'])
  })

  it('refuses the whole adoption on an id collision', () => {
    const incoming = closedWindowWorkspace()
    incoming.sessions['own-agent'] = meta('/collision')

    const adoption = adoptWorkspace(survivorState(), incoming)
    // WHY refusing beats merging what fits: both id spaces are randomUUID, so a
    // collision means something is already wrong. Dropping the colliding rows
    // could strand live sessions — alive in SessionManager, owned by no window,
    // invisible and unkillable. Refusing leaves the closed slice on disk, so
    // the next launch restores it as its own window with everything intact.
    expect(adoption.ok).toBe(false)
  })

  it('refuses when a tab id collides', () => {
    const incoming = closedWindowWorkspace()
    incoming.tabs[0]!.id = 'tab-own'
    expect(adoptWorkspace(survivorState(), incoming).ok).toBe(false)
  })

  it('adopts an empty workspace without inventing rows', () => {
    const adoption = adoptWorkspace(survivorState(), {
      tabs: [],
      activeTabId: 'gone',
      dispatchMode: null,
      sessions: {},
      tileTabs: null,
    })
    if (!adoption.ok) throw new Error('expected adoption')
    expect(adoption.state.tabs).toHaveLength(1)
    expect(adoption.adoptedSessionIds).toEqual([])
  })
})
