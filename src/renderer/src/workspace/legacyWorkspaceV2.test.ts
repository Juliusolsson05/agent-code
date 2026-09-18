import { describe, expect, it } from 'vitest'

import {
  collectLegacyLeaves,
  legacyEntrySeed,
  legacyMemberships,
  type LegacyTab,
  type LegacyTileNode,
  type LegacyWorkspaceV2Fields,
} from '@renderer/workspace/legacyWorkspaceV2'
import type { SessionId, SessionMeta } from '@renderer/workspace/types'

// The v2 ownership rules, tested against the v2 shapes they were learned from.
//
// These cases lived in sessionOwnership.test.ts while live state still had a
// tile tree, a detached bucket and a buried bucket. #992 deleted those from
// live state; the rules survive in the legacy reader because every one of them
// decides what an UPGRADING user keeps, and each was a production incident
// before it was a rule.

type V2 = LegacyWorkspaceV2Fields & { sessions: Record<SessionId, SessionMeta> }

const leaf = (sessionId: string): LegacyTileNode => ({ type: 'leaf', sessionId })
const meta = (cwd = '/work/project-a'): SessionMeta => ({ cwd, kind: 'claude' })
const tab = (id: string, root: LegacyTileNode, focusedSessionId = ''): LegacyTab =>
  ({ id, title: id, root, focusedSessionId })

function detached(sessionId: string, projectTabId: string, detachedAt: number) {
  return {
    sessionId, surface: 'dispatch' as const, projectTabId,
    projectTabTitle: projectTabId, projectTabIndex: 0, detachedAt,
  }
}

describe('collectLegacyLeaves', () => {
  it('lists leaves depth-first, which is the order the grid showed them in', () => {
    const tree: LegacyTileNode = {
      type: 'split', direction: 'vertical', ratio: 0.5,
      a: leaf('a'),
      b: { type: 'split', direction: 'horizontal', ratio: 0.5, a: leaf('b'), b: leaf('c') },
    }
    expect(collectLegacyLeaves(tree)).toEqual(['a', 'b', 'c'])
  })

  it('is total on a malformed tree instead of throwing at boot', () => {
    // A throw here is a lost workspace: rehydrate would fall to its recovery
    // path with autosave locked.
    expect(collectLegacyLeaves(undefined)).toEqual([])
    expect(collectLegacyLeaves({ type: 'split', direction: 'vertical', ratio: 0.5, a: leaf('a') } as unknown as LegacyTileNode))
      .toEqual(['a'])
    expect(collectLegacyLeaves({ type: 'mystery' } as unknown as LegacyTileNode)).toEqual([])
  })
})

describe('legacyMemberships', () => {
  it('orders a project as v2 listed it: tree leaves first, then detached oldest-first', () => {
    const input: V2 = {
      tabs: [tab('tabA', { type: 'split', direction: 'vertical', ratio: 0.5, a: leaf('l1'), b: leaf('l2') })],
      sessions: { l1: meta(), l2: meta(), d1: meta(), d2: meta() },
      detachedSessions: { d2: detached('d2', 'tabA', 900), d1: detached('d1', 'tabA', 400) },
    }
    const members = legacyMemberships(input)
    const ordered = [...members.entries()].sort((a, b) => a[1].joinedAt - b[1].joinedAt).map(([id]) => id)

    expect(ordered).toEqual(['l1', 'l2', 'd1', 'd2'])
    // Every leaf ordinal is smaller than every real timestamp, which is what
    // "leaves first" meant.
    expect(members.get('l2')!.joinedAt).toBeLessThan(members.get('d1')!.joinedAt)
  })

  it('does not own a tile leaf that has no metadata', () => {
    // Recorded from a real workspace.json: a split whose `b` leaf named a
    // session with no row in `sessions`. Counting it made restore completion
    // unsatisfiable, so autosave stayed locked and the file could never be
    // repaired — every launch for three weeks journalled
    // `expectedCount 4, resolvedCount 3, ok false`.
    const input: V2 = {
      tabs: [tab('tabA', { type: 'split', direction: 'vertical', ratio: 0.5, a: leaf('live'), b: leaf('orphan') }, 'orphan')],
      sessions: { live: meta() },
    }
    expect([...legacyMemberships(input).keys()]).toEqual(['live'])
  })

  it('does not read metadata through the prototype chain', () => {
    // A leaf id like `toString` resolves to an inherited function under a bare
    // index read, which would classify a genuine orphan as healthy.
    const input: V2 = { tabs: [tab('tabA', leaf('toString'), 'toString')], sessions: {} }
    expect(legacyMemberships(input).size).toBe(0)
  })

  it('collapses a production-shaped ghost pool without touching valid parked agents', () => {
    // WHY the observed production cardinalities instead of one more
    // one-record example: the bug was first mistaken for legitimate lazy
    // recovery because each invalid record looked well-formed on its own. 8
    // real parked agents beside 82 records whose project tab had been closed;
    // parent-tab reachability is the rule, not any count. Spawning that pool
    // at boot was the #258 fork bomb.
    const input: V2 = {
      tabs: [tab('tabA', leaf('live'), 'live')],
      sessions: { live: meta() },
      detachedSessions: {},
    }
    for (let index = 0; index < 8; index += 1) {
      input.sessions[`parked-${index}`] = meta()
      input.detachedSessions![`parked-${index}`] = detached(`parked-${index}`, 'tabA', index)
    }
    for (let index = 0; index < 82; index += 1) {
      input.sessions[`ghost-${index}`] = meta(`/work/deleted-${index}`)
      input.detachedSessions![`ghost-${index}`] = detached(`ghost-${index}`, `deleted-tab-${index}`, index)
    }
    const members = legacyMemberships(input)

    expect(members.size).toBe(9)
    expect(members.has('parked-7')).toBe(true)
    expect(members.has('ghost-0')).toBe(false)
    expect(members.has('ghost-81')).toBe(false)
  })

  it('keeps a buried session unconditionally, flagging a dead source project for re-parenting', () => {
    // v2 owned buried sessions even when their source tab had been closed
    // (Revive minted a tab for them), and a buried record could be the ONLY
    // place its metadata lived.
    const buriedMeta = meta('/work/archive')
    const input: V2 = {
      tabs: [tab('tabA', leaf('live'), 'live')],
      sessions: { live: meta() },
      buried: [{
        id: 'hidden', sessionId: 'hidden', sessionMeta: buriedMeta, buriedAt: 7,
        sourceTabId: 'already-closed', sourceTabTitle: 'archive', sourceTabIndex: 2,
      }],
    }
    expect(legacyMemberships(input).get('hidden')).toEqual({
      projectId: null, joinedAt: 7, restoredMeta: buriedMeta,
    })
  })

  it('never gives a session a second owner: leaf beats detached beats buried', () => {
    const input: V2 = {
      tabs: [tab('tabA', leaf('s'), 's'), tab('tabB', leaf('other'), 'other')],
      sessions: { s: meta(), other: meta() },
      detachedSessions: { s: detached('s', 'tabB', 50) },
      buried: [{ id: 's', sessionId: 's', sessionMeta: meta(), buriedAt: 9, sourceTabId: 'tabB', sourceTabTitle: 'b', sourceTabIndex: 1 }],
    }
    expect(legacyMemberships(input).get('s')).toEqual({ projectId: 'tabA', joinedAt: 0 })
  })
})

describe('legacyEntrySeed (#977)', () => {
  const base: V2 = {
    tabs: [tab('tabA', leaf('a1'), 'a1'), tab('tabB', leaf('b1'), 'b1')],
    activeTabId: 'tabA',
    sessions: { a1: meta(), b1: meta() },
  }

  it('prefers the classic-Dispatch focus over the active tab s tree focus', () => {
    expect(legacyEntrySeed(base)).toBe('a1')
    expect(legacyEntrySeed({ ...base, dispatchMode: { scope: 'project', focusedSessionId: 'b1' } })).toBe('b1')
  })

  it('is null when the candidate is missing, and never a buried session', () => {
    expect(legacyEntrySeed({ ...base, dispatchMode: { focusedSessionId: 'ghost' } })).toBeNull()
    // The user hid it on purpose; an upgrade must not put it back on screen.
    expect(legacyEntrySeed({
      ...base,
      buried: [{ id: 'a1', sessionId: 'a1', sessionMeta: meta(), buriedAt: 1, sourceTabId: 'tabA', sourceTabTitle: 'a', sourceTabIndex: 0 }],
    })).toBeNull()
  })
})
