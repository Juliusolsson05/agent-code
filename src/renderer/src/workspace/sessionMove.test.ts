import { describe, expect, it } from 'vitest'

import {
  buildSessionMovePacket,
  collectMoveSubtree,
  parseSessionMovePacket,
  receiveMovedSessions,
} from '@renderer/workspace/sessionMove'
import { workspaceWithoutSessions } from '@renderer/workspace/pool'
import { collectOwnedSessionIds } from '@renderer/workspace/sessionOwnership'
import { resolveTabSessions } from '@renderer/workspace/queries'
import type { SessionMeta, WorkspaceState } from '@renderer/workspace/types'

// Two windows' workspaces, reduced to what a move has to reason about.
//
// SOURCE: an orchestration coordinator with a worker that has a worker of its
// own (the grandchild case dispatchSelectors documents), a manually linked
// agent, and an unrelated agent in the same project. The coordinator is in a
// lane and pinned; the worker has a draft.
//
// TARGET: already has a project for the same folder, plus one unrelated
// project, so both "join the same-folder project" and "mint a new project"
// can be exercised.

function meta(cwd: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return { cwd, kind: 'claude', ...extra }
}

function source(): WorkspaceState {
  return {
    tabs: [{ id: 'src-agent-code', title: 'agent-code' }, { id: 'src-site', title: 'site' }],
    activeTabId: 'src-agent-code',
    stage: {
      lanes: [{ selectedSessionId: 'coordinator' }, { selectedSessionId: 'bystander' }],
      rows: [{ length: 2, expandedParents: ['coordinator'] }],
      focusedLane: 0,
    },
    sessions: {
      coordinator: meta('/dev/agent-code', { projectId: 'src-agent-code', joinedAt: 1, title: 'Coordinator' }),
      worker: meta('/dev/agent-code/.worktrees/a', { projectId: 'src-agent-code', joinedAt: 3, orchestrationParentId: 'coordinator' }),
      grandchild: meta('/dev/agent-code/.worktrees/b', { projectId: 'src-agent-code', joinedAt: 4, orchestrationParentId: 'worker' }),
      linked: meta('/dev/agent-code', { projectId: 'src-agent-code', joinedAt: 2, linkedParentId: 'coordinator' }),
      bystander: meta('/dev/agent-code', { projectId: 'src-agent-code', joinedAt: 5 }),
      // A child filed in a DIFFERENT project than its parent.
      'site-child': meta('/dev/site', { projectId: 'src-site', joinedAt: 1, linkedParentId: 'coordinator' }),
    },
    pinnedSessionIds: ['bystander', 'coordinator'],
  }
}

function target(): WorkspaceState {
  return {
    tabs: [{ id: 'dst-agent-code', title: 'agent-code (main)' }, { id: 'dst-other', title: 'other' }],
    activeTabId: 'dst-other',
    stage: { lanes: [{ selectedSessionId: 'resident' }], rows: [{ length: 1 }], focusedLane: 0 },
    sessions: {
      resident: meta('/dev/agent-code', { projectId: 'dst-agent-code', joinedAt: 50 }),
      other: meta('/dev/other', { projectId: 'dst-other', joinedAt: 1 }),
    },
    pinnedSessionIds: ['other'],
  }
}

const ids = (prefix: string) => {
  let next = 0
  return () => `${prefix}-${++next}`
}

describe('collectMoveSubtree', () => {
  it('takes the agent and every descendant over both ownership edges, depth first in index order', () => {
    expect(collectMoveSubtree(source().sessions, 'coordinator'))
      .toEqual(['coordinator', 'site-child', 'linked', 'worker', 'grandchild'])
  })

  it('is cycle-safe and ignores self-links', () => {
    const sessions = {
      a: meta('/x', { linkedParentId: 'b' }),
      b: meta('/x', { orchestrationParentId: 'a' }),
      c: meta('/x', { linkedParentId: 'c' }),
    }
    expect(collectMoveSubtree(sessions, 'a')).toEqual(['a', 'b'])
    expect(collectMoveSubtree(sessions, 'c')).toEqual(['c'])
    expect(collectMoveSubtree(sessions, 'missing')).toEqual([])
  })
})

describe('what may be moved', () => {
  it('refuses an extension view, which has no backend and needs its extension in the other window', () => {
    const state = source()
    state.sessions.view = meta('/dev/agent-code', { projectId: 'src-agent-code', joinedAt: 9, kind: 'extension-view' })
    expect(buildSessionMovePacket(state, {}, 'view')).toMatchObject({ ok: false })
    // A terminal moves like an agent.
    state.sessions.shell = meta('/dev/agent-code', { projectId: 'src-agent-code', joinedAt: 10, kind: 'terminal' })
    expect(buildSessionMovePacket(state, {}, 'shell')).toMatchObject({ ok: true })
  })
})

describe('buildSessionMovePacket → receiveMovedSessions', () => {
  function moved() {
    const built = buildSessionMovePacket(source(), { worker: 'half-written prompt', bystander: 'not moving' }, 'coordinator')
    if (!built.ok) throw new Error(built.message)
    // Through JSON, as the packet really travels.
    const packet = parseSessionMovePacket(JSON.stringify(built.packet))
    if (!packet) throw new Error('packet did not survive the wire')
    return { built, packet }
  }

  it('carries exactly the subtree, its projects, its pins and its drafts', () => {
    const { built, packet } = moved()
    expect(built.sessionIds).toEqual(['coordinator', 'site-child', 'linked', 'worker', 'grandchild'])
    expect(Object.keys(packet.sessions).sort()).toEqual([...built.sessionIds].sort())
    expect(packet.projects.map(project => project.id)).toEqual(['src-agent-code', 'src-site'])
    expect(packet.pinnedSessionIds).toEqual(['coordinator'])
    expect(packet.drafts).toEqual({ worker: 'half-written prompt' })
  })

  it('joins a same-folder project, mints a fresh tab for the rest, and keeps every row owned', () => {
    const { packet } = moved()
    // A clock BEHIND the target's own rows (resident joinedAt 50): moved rows
    // must still append after them, never sort above what the target lists.
    const result = receiveMovedSessions(target(), packet, { now: 10, newTabId: ids('fresh') })
    if (!result.ok) throw new Error(result.reason)
    const { state } = result

    // The agent-code project already exists in the target (same folder as the
    // coordinator), so those rows join it, appended after its own rows.
    expect(resolveTabSessions(state, 'dst-agent-code')).toEqual(['resident', 'coordinator', 'linked', 'worker', 'grandchild'])
    // No target project holds /dev/site: a NEW tab, with a FRESH id rather
    // than the source's, so a later window-close adoption cannot collide.
    expect(result.addedTabIds).toEqual(['fresh-1'])
    expect(state.tabs.at(-1)).toEqual({ id: 'fresh-1', title: 'site' })
    expect(state.tabs.some(tab => tab.id === 'src-site')).toBe(false)
    expect(resolveTabSessions(state, 'fresh-1')).toEqual(['site-child'])
    // Every moved row has an owner, or the next autosave would drop it.
    expect([...collectOwnedSessionIds(state)].sort())
      .toEqual(['coordinator', 'grandchild', 'linked', 'other', 'resident', 'site-child', 'worker'])
    // Pins append; focus and the target's lanes are untouched (the lane
    // placement goes through the lane-select action afterwards).
    expect(state.pinnedSessionIds).toEqual(['other', 'coordinator'])
    expect(state.activeTabId).toBe('dst-other')
    expect(state.stage.lanes).toEqual([{ selectedSessionId: 'resident' }])
    // Relationship fields are carried verbatim: they name session ids, which
    // do not change in a move.
    expect(state.sessions.worker?.orchestrationParentId).toBe('coordinator')
  })

  it('refuses when the target already shows one of the agents, changing nothing', () => {
    const { packet } = moved()
    const current = target()
    current.sessions.worker = meta('/dev/agent-code', { projectId: 'dst-agent-code', joinedAt: 60 })
    expect(receiveMovedSessions(current, packet, { now: 100, newTabId: ids('fresh') }))
      .toMatchObject({ ok: false })
  })

  it('rejects packets whose rows name a project the packet does not carry', () => {
    const { packet } = moved()
    packet.sessions.worker = { ...packet.sessions.worker!, projectId: 'nowhere' }
    expect(parseSessionMovePacket(JSON.stringify(packet))).toBeNull()
    expect(parseSessionMovePacket('{not json')).toBeNull()
    expect(parseSessionMovePacket(JSON.stringify({ ...packet, version: 2 }))).toBeNull()
  })
})

// The source drop and the target cancel both use workspaceWithoutSessions
// (pool.ts has its own suite). These pin the two MOVE contracts on top of it.
describe('dropping moved rows', () => {
  it('drops the rows, clears (not removes) their lanes, and scrubs pins and expanded parents', () => {
    const before = source()
    const moving = collectMoveSubtree(before.sessions, 'coordinator')
    const after = workspaceWithoutSessions(before, moving)

    expect(Object.keys(after.sessions)).toEqual(['bystander'])
    // Owner ruling 4: the lane stays, empty, like Clear Lane.
    expect(after.stage.lanes).toEqual([{ selectedSessionId: undefined }, { selectedSessionId: 'bystander' }])
    expect(after.pinnedSessionIds).toEqual(['bystander'])
    expect(after.stage.rows?.[0]?.expandedParents ?? []).toEqual([])
    // The site project emptied and goes; agent-code still holds the bystander.
    expect(after.tabs.map(tab => tab.id)).toEqual(['src-agent-code'])
  })

  it('removes a project the move created only if it is still empty (target-side cancel)', () => {
    const built = buildSessionMovePacket(source(), {}, 'coordinator')
    if (!built.ok) throw new Error(built.message)
    const received = receiveMovedSessions(target(), built.packet, { now: 100, newTabId: ids('fresh') })
    if (!received.ok) throw new Error(received.reason)

    const cancelled = workspaceWithoutSessions(received.state, received.movedSessionIds, received.addedTabIds)
    expect(cancelled.tabs).toEqual(target().tabs)
    expect(cancelled.sessions).toEqual(target().sessions)
    expect(cancelled.pinnedSessionIds).toEqual(target().pinnedSessionIds)
  })
})
