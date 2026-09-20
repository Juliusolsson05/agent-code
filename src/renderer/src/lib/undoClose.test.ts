import { describe, expect, it } from 'vitest'

import {
  UNDO_CLOSE_MAX_ENTRIES,
  UNDO_CLOSE_RETENTION_MS,
  UndoCloseStack,
  remapClosedEntryLineage,
  remapMetaLineage,
} from './undoClose'
import type { ClosedGroup, ClosedSession, ClosedTab, UndoLineage } from './undoClose'
import type { SessionMeta } from '@renderer/workspace/types'

// Undo lineage (#886 review round 1 finding 4; coverage asked for in round 2 N3).
//
// A restore respawns under new ids, and entries still waiting on the stack were
// captured against the old ones. The contract pinned here is narrow on purpose:
// rewrite only ANCHORS (the project an entry returns to, and the relationship
// pointers its respawned session will carry), keep ids the restore did not
// touch, and never rewrite an entry's OWN closed ids — those sessions are dead,
// and the entry is the only thing that will ever bring them back.
//
// (Until #992 these cases covered three tree-era shapes: a split pane anchored
// on a sibling leaf, a Dispatch row anchored on a record and an optional
// promoted survivor, and a tab carrying a tile tree. A session's whole
// placement is `projectId` + `joinedAt` now, so there are two shapes.)

const lineage: UndoLineage = {
  sessions: new Map([
    ['parent', 'parent-2'],
    // Present only to prove an entry's own closed id is never rewritten.
    ['closed', 'must-not-appear'],
  ]),
  tabs: new Map([['tab', 'tab-2']]),
}

const meta = (patch: Partial<SessionMeta> = {}): SessionMeta =>
  ({ cwd: '/project', kind: 'codex', projectId: 'tab', joinedAt: 7, ...patch })

describe('remapClosedEntryLineage', () => {
  it('re-anchors a session on its restored project and parent, but not its own id or position', () => {
    const entry: ClosedSession = {
      type: 'session', closedAt: 1, sessionId: 'closed',
      sessionMeta: meta({ linkedParentId: 'parent' }),
    }
    expect(remapClosedEntryLineage(entry, lineage)).toEqual({
      ...entry,
      sessionMeta: meta({ linkedParentId: 'parent-2', projectId: 'tab-2' }),
    })
  })

  it('re-points a closed project s relationship pointers but never its own ids', () => {
    // The tab's own id is NOT remapped: restoring this entry is what would
    // mint its replacement, and its sessions' `projectId` is overwritten then.
    const entry: ClosedTab = {
      type: 'tab', closedAt: 1, tab: { id: 'tab', title: 'Project' }, tabIndex: 0,
      sessions: [
        { sessionId: 'closed', meta: meta({ orchestrationParentId: 'parent', orchestrationRootId: 'parent' }) },
        { sessionId: 'other', meta: meta({ joinedAt: 9 }) },
      ],
    }
    const remapped = remapClosedEntryLineage(entry, lineage) as ClosedTab
    expect(remapped.tab.id).toBe('tab')
    expect(remapped.sessions.map(member => member.sessionId)).toEqual(['closed', 'other'])
    expect(remapped.sessions[0]!.meta).toMatchObject({
      orchestrationParentId: 'parent-2', orchestrationRootId: 'parent-2',
    })
  })

  it('keeps ids the restore did not touch', () => {
    const entry: ClosedSession = {
      type: 'session', closedAt: 1, sessionId: 'closed',
      sessionMeta: meta({ linkedParentId: 'someone-else', projectId: 'another-tab' }),
    }
    expect(remapClosedEntryLineage(entry, lineage)).toEqual(entry)
  })

  it('re-anchors every member of a group', () => {
    const group: ClosedGroup = {
      type: 'group', closedAt: 1,
      entries: [
        { type: 'session', closedAt: 1, sessionId: 'c1', sessionMeta: meta({ linkedParentId: 'parent' }) },
        { type: 'session', closedAt: 1, sessionId: 'c2', sessionMeta: meta({ projectId: 'another-tab' }) },
      ],
    }
    const remapped = remapClosedEntryLineage(group, lineage) as ClosedGroup
    expect(remapped.entries.map(entry => (entry as ClosedSession).sessionMeta.projectId)).toEqual(['tab-2', 'another-tab'])
    expect((remapped.entries[0] as ClosedSession).sessionMeta.linkedParentId).toBe('parent-2')
  })
})

describe('remapMetaLineage', () => {
  it('returns the same object when no pointer changes, so untouched metadata keeps its identity', () => {
    const untouched = meta({ linkedParentId: 'someone-else' })
    expect(remapMetaLineage(untouched, lineage.sessions)).toBe(untouched)
    expect(remapMetaLineage(untouched, undefined)).toBe(untouched)
  })
})

describe('UndoCloseStack', () => {
  const entry = (sessionId: string, closedAt: number): ClosedSession =>
    ({ type: 'session', closedAt, sessionId, sessionMeta: meta() })

  it('rewrites the anchors of every entry still waiting', () => {
    const stack = new UndoCloseStack(() => 10)
    stack.push({ type: 'session', closedAt: 5, sessionId: 'closed', sessionMeta: meta({ linkedParentId: 'parent' }) })
    stack.remapLineage(lineage)
    expect((stack.peek() as ClosedSession).sessionMeta).toMatchObject({ linkedParentId: 'parent-2', projectId: 'tab-2' })
  })

  it('is LIFO and keeps only the most recent entries', () => {
    const stack = new UndoCloseStack(() => 1_000)
    for (let index = 0; index < UNDO_CLOSE_MAX_ENTRIES + 3; index += 1) stack.push(entry(`s${index}`, 1_000))
    expect(stack.length).toBe(UNDO_CLOSE_MAX_ENTRIES)
    expect((stack.pop() as ClosedSession).sessionId).toBe(`s${UNDO_CLOSE_MAX_ENTRIES + 2}`)
  })

  it('expires entries lazily, so a stale close is never offered back', () => {
    let now = 0
    const stack = new UndoCloseStack(() => now)
    stack.push(entry('old', 0))
    now = UNDO_CLOSE_RETENTION_MS + 1
    expect(stack.length).toBe(0)
    expect(stack.pop()).toBeNull()
  })
})
