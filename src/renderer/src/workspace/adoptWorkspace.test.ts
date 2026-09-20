import { describe, expect, it } from 'vitest'

import { adoptWorkspace } from '@renderer/workspace/adoptWorkspace'
import { collectOwnedSessionIds } from '@renderer/workspace/sessionOwnership'
import { resolveTabSessions } from '@renderer/workspace/queries'
import type { PersistedWorkspace } from '@renderer/workspace/persistence'
import type { SessionMeta, WorkspaceState } from '@renderer/workspace/types'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'

// Closing a window must not kill its agents. They stay alive in SessionManager
// and the surviving window takes over their workspace.
//
// The load-bearing test here is the first one: a session is owned because its
// `projectId` names a project that exists, so an adoption that moved sessions
// WITHOUT their projects would look correct and then be deleted by the
// survivor's very next autosave.
//
// The closed window's slice is a FILE, and may be of any generation: a window
// that has not saved since the upgrade still holds a v2 document. Both are
// exercised; the v2 one is the recorded shape this suite always used.

function meta(cwd: string): SessionMeta {
  return { cwd, kind: 'claude' }
}

function survivorState(): WorkspaceState {
  return {
    tabs: [{ id: 'tab-own', title: 'own-project' }],
    activeTabId: 'tab-own',
    stage: oneLaneStage('own-agent'),
    sessions: { 'own-agent': { ...meta('/own'), projectId: 'tab-own', joinedAt: 0 } },
    pinnedSessionIds: ['own-agent'],
  }
}

/** v2: a tab owning a split, a parked Dispatch row, and a buried pane. */
function closedV2Window(): PersistedWorkspace {
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
    dispatchMode: { scope: 'global', tiled: { lanes: [{ selectedSessionId: 'grid-a' }], focusedLane: 0 } },
    sessions: {
      'grid-a': meta('/closed'),
      'grid-b': meta('/closed'),
      parked: meta('/closed'),
      entombed: meta('/closed'),
    },
    detachedSessions: {
      parked: {
        sessionId: 'parked', surface: 'dispatch', projectTabId: 'tab-closed',
        projectTabTitle: 'closed-project', projectTabIndex: 0, detachedAt: 10,
      },
    },
    buried: [{
      id: 'entombed', sessionId: 'entombed', sessionMeta: meta('/closed'), buriedAt: 20,
      sourceTabId: 'tab-closed', sourceTabTitle: 'closed-project', sourceTabIndex: 0,
    }],
    pinnedSessionIds: ['parked'],
    drafts: { 'grid-a': 'half-written prompt' },
  }
}

/** v3: the same workspace as this build writes it. */
function closedV3Window(): PersistedWorkspace {
  return {
    projects: [{ id: 'tab-closed', title: 'closed-project' }],
    activeProjectId: 'tab-closed',
    stage: oneLaneStage('grid-a'),
    sessions: {
      'grid-a': { ...meta('/closed'), projectId: 'tab-closed', joinedAt: 0 },
      'grid-b': { ...meta('/closed'), projectId: 'tab-closed', joinedAt: 1 },
      parked: { ...meta('/closed'), projectId: 'tab-closed', joinedAt: 10 },
      entombed: { ...meta('/closed'), projectId: 'tab-closed', joinedAt: 20 },
    },
    pinnedSessionIds: ['parked'],
    drafts: { 'grid-a': 'half-written prompt' },
  }
}

describe.each([
  ['a v2 slice', closedV2Window],
  ['a v3 slice', closedV3Window],
])('adopting a closed window — %s', (_label, closedWindow) => {
  it('keeps every adopted session owned, because its project comes with it', () => {
    const adoption = adoptWorkspace(survivorState(), closedWindow())
    expect(adoption.ok).toBe(true)
    if (!adoption.ok) return

    // The real assertion is not "the row is present" — it is that the
    // survivor's own ownership rules still consider it owned. A bare row whose
    // project did not come along would pass a presence check and then be
    // pruned on the next autosave, silently losing a live agent.
    const owned = collectOwnedSessionIds(adoption.state)
    // Parked and (in v2) buried sessions were claimed to survive without ever
    // being exercised; they are the ones no lane was showing.
    expect([...owned].sort()).toEqual(['entombed', 'grid-a', 'grid-b', 'own-agent', 'parked'])
  })

  it('lists the adopted project s agents in the order the closed window listed them', () => {
    const adoption = adoptWorkspace(survivorState(), closedWindow())
    if (!adoption.ok) throw new Error('expected adoption')
    const state = { ...survivorState(), ...adoption.state }

    expect(adoption.state.tabs.map(tab => tab.id)).toEqual(['tab-own', 'tab-closed'])
    expect(resolveTabSessions(state, 'tab-closed')).toEqual(['grid-a', 'grid-b', 'parked', 'entombed'])
    // Every adopted session needs a runtime, not just the ones with a backend:
    // the wake path for a parked agent no-ops without one.
    expect([...adoption.adoptedSessionIds].sort()).toEqual(['entombed', 'grid-a', 'grid-b', 'parked'])
  })

  it('does not adopt the closed window s STAGE', () => {
    // A stage is one window's screen. The survivor's lanes show what ITS user
    // arranged, and another window closing is not a request to rearrange them.
    const adoption = adoptWorkspace(survivorState(), closedWindow())
    if (!adoption.ok) throw new Error('expected adoption')
    expect(adoption.state).not.toHaveProperty('stage')
  })

  it('carries pins and drafts across', () => {
    const adoption = adoptWorkspace(survivorState(), closedWindow())
    if (!adoption.ok) throw new Error('expected adoption')
    // Order matters: pinnedSessionIds IS the Pinned section's render order, and
    // the survivor's own pins were arranged more recently.
    expect(adoption.state.pinnedSessionIds).toEqual(['own-agent', 'parked'])
    expect(adoption.drafts).toEqual({ 'grid-a': 'half-written prompt' })
  })

  it('leaves the survivor s own workspace untouched', () => {
    const before = survivorState()
    const adoption = adoptWorkspace(before, closedWindow())
    if (!adoption.ok) throw new Error('expected adoption')
    expect(adoption.state.tabs[0]).toBe(before.tabs[0])
    expect(adoption.state.sessions['own-agent']).toBe(before.sessions['own-agent'])
  })

  it('refuses the whole adoption on a session id collision', () => {
    const incoming = closedWindow()
    incoming.sessions['own-agent'] = { ...meta('/collision'), projectId: 'tab-closed', joinedAt: 99 }
    if (incoming.tabs) incoming.detachedSessions = {
      ...incoming.detachedSessions,
      'own-agent': { sessionId: 'own-agent', surface: 'dispatch', projectTabId: 'tab-closed', projectTabTitle: 'c', projectTabIndex: 0, detachedAt: 99 },
    }

    // WHY refusing beats merging what fits: both id spaces are randomUUID, so a
    // collision means something is already wrong. Dropping the colliding rows
    // could strand live sessions — alive in SessionManager, owned by no window,
    // invisible and unkillable. Refusing leaves the closed slice on disk, so
    // the next launch restores it as its own window with everything intact.
    expect(adoptWorkspace(survivorState(), incoming).ok).toBe(false)
  })

  it('refuses when a project id collides', () => {
    const incoming = closedWindow()
    if (incoming.tabs) incoming.tabs[0]!.id = 'tab-own'
    if (incoming.projects) incoming.projects[0]!.id = 'tab-own'
    expect(adoptWorkspace(survivorState(), incoming).ok).toBe(false)
  })
})

describe('adopting a degenerate slice', () => {
  it('adopts an empty workspace without inventing rows', () => {
    const before = survivorState()
    const adoption = adoptWorkspace(before, { tabs: [], activeTabId: 'gone', sessions: {} })
    if (!adoption.ok) throw new Error('expected adoption')
    expect(adoption.state.tabs).toEqual(before.tabs)
    expect(adoption.adoptedSessionIds).toEqual([])
  })

  it('reads a slice with no sessions map defensively instead of throwing', () => {
    // The slice is another window's file, opaque to main and hand-editable.
    const adoption = adoptWorkspace(survivorState(), {} as unknown as PersistedWorkspace)
    expect(adoption.ok).toBe(true)
  })

  it('does not adopt a project whose every session was unowned', () => {
    // A v2 detached record naming a project the slice does not contain is a
    // ghost; nothing is filed under `tab-empty`, so it would be a header over
    // an empty list.
    const adoption = adoptWorkspace(survivorState(), {
      tabs: [{ id: 'tab-empty', title: 'empty', focusedSessionId: 'nobody', root: { type: 'leaf', sessionId: 'nobody' } }],
      activeTabId: 'tab-empty',
      sessions: { ghost: meta('/gone') },
      detachedSessions: {
        ghost: { sessionId: 'ghost', surface: 'dispatch', projectTabId: 'tab-closed-long-ago', projectTabTitle: 'x', projectTabIndex: 0, detachedAt: 1 },
      },
    })
    if (!adoption.ok) throw new Error('expected adoption')
    expect(adoption.state.tabs.map(tab => tab.id)).toEqual(['tab-own'])
    expect(adoption.adoptedSessionIds).toEqual([])
  })
})
