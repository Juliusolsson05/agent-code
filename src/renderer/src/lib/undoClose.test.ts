import { describe, expect, it } from 'vitest'

import { UndoCloseStack, remapClosedEntryLineage, remapMetaLineage } from './undoClose'
import type { ClosedDetached, ClosedGroup, ClosedPane, ClosedTab, UndoLineage } from './undoClose'
import type { DetachedSessionRecord, SessionMeta } from '@renderer/workspace/types'

// Undo lineage (#886 review round 1 finding 4; coverage asked for in round 2 N3).
//
// A restore respawns under new ids, and entries still waiting on the stack were
// captured against the old ones. The contract pinned here is narrow on purpose:
// rewrite only ANCHORS (where an entry belongs, and the relationship pointers
// its respawned session will carry), keep ids the restore did not touch, and
// never rewrite an entry's OWN closed ids — those sessions are dead, and the
// entry is the only thing that will ever bring them back.

const lineage: UndoLineage = {
  sessions: new Map([
    ['parent', 'parent-2'],
    ['sibling', 'sibling-2'],
    ['survivor', 'survivor-2'],
    // Present only to prove an entry's own closed id is never rewritten.
    ['closed', 'must-not-appear'],
  ]),
  tabs: new Map([['tab', 'tab-2']]),
}

const meta = (patch: Partial<SessionMeta> = {}): SessionMeta => ({ cwd: '/project', kind: 'codex', ...patch })

const row = (sessionId: string, projectTabId: string): DetachedSessionRecord => ({
  sessionId, surface: 'dispatch', projectTabId, projectTabTitle: 'Project', projectTabIndex: 0, detachedAt: 7,
})

describe('remapClosedEntryLineage', () => {
  it('re-anchors a pane on its sibling and tab, and its parent pointer, but not its own id', () => {
    const pane: ClosedPane = {
      type: 'pane', closedAt: 1, tabId: 'tab', sessionId: 'closed',
      sessionMeta: meta({ linkedParentId: 'parent' }),
      direction: 'vertical', ratio: 0.5, side: 'a', siblingLeafId: 'sibling',
    }
    expect(remapClosedEntryLineage(pane, lineage)).toEqual({
      ...pane, tabId: 'tab-2', siblingLeafId: 'sibling-2', sessionMeta: meta({ linkedParentId: 'parent-2' }),
    })
  })

  it('re-anchors a Dispatch row on its project and promoted survivor, but not its own record id', () => {
    const detached: ClosedDetached = {
      type: 'detached', closedAt: 1,
      sessionMeta: meta({ orchestrationParentId: 'parent', orchestrationRootId: 'parent' }),
      record: row('closed', 'tab'),
      replacedRoot: row('survivor', 'tab'),
    }
    expect(remapClosedEntryLineage(detached, lineage)).toEqual({
      ...detached,
      sessionMeta: meta({ orchestrationParentId: 'parent-2', orchestrationRootId: 'parent-2' }),
      record: row('closed', 'tab-2'),
      replacedRoot: row('survivor-2', 'tab-2'),
    })
  })

  it('re-points a closed tab\'s relationship pointers but never its own leaves, keys or rows', () => {
    const tab: ClosedTab = {
      type: 'tab', closedAt: 1, tabIndex: 0,
      tab: { id: 'tab', title: 'Project', root: { type: 'leaf', sessionId: 'closed' }, focusedSessionId: 'closed' },
      sessionMetas: { closed: meta({ linkedParentId: 'parent' }) },
      detachedEntries: [{ sessionId: 'closed', meta: meta({ linkedParentId: 'parent' }), detachedAt: 3 }],
    }
    expect(remapClosedEntryLineage(tab, lineage)).toEqual({
      ...tab,
      sessionMetas: { closed: meta({ linkedParentId: 'parent-2' }) },
      detachedEntries: [{ sessionId: 'closed', meta: meta({ linkedParentId: 'parent-2' }), detachedAt: 3 }],
    })
  })

  it('keeps ids the restore did not touch', () => {
    const detached: ClosedDetached = {
      type: 'detached', closedAt: 1,
      sessionMeta: meta({ linkedParentId: 'unrelated-parent' }),
      record: row('other', 'unrelated-tab'),
      replacedRoot: row('unrelated-survivor', 'unrelated-tab'),
    }
    expect(remapClosedEntryLineage(detached, lineage)).toEqual(detached)
  })

  it('re-anchors every member of a group', () => {
    const group: ClosedGroup = {
      type: 'group', closedAt: 1,
      entries: [
        { type: 'detached', closedAt: 1, sessionMeta: meta({ linkedParentId: 'parent' }), record: row('closed', 'tab') },
        {
          type: 'pane', closedAt: 1, tabId: 'tab', sessionId: 'closed', sessionMeta: meta(),
          direction: 'horizontal', ratio: 0.5, side: 'b', siblingLeafId: 'sibling',
        },
      ],
    }
    expect(remapClosedEntryLineage(group, lineage)).toMatchObject({
      type: 'group',
      entries: [
        { sessionMeta: { linkedParentId: 'parent-2' }, record: { sessionId: 'closed', projectTabId: 'tab-2' } },
        { sessionId: 'closed', tabId: 'tab-2', siblingLeafId: 'sibling-2' },
      ],
    })
  })
})

describe('remapMetaLineage', () => {
  it('returns the same object when no pointer changes, so untouched metadata keeps its identity', () => {
    const untouched = meta({ linkedParentId: 'unrelated-parent' })
    expect(remapMetaLineage(untouched, lineage.sessions)).toBe(untouched)
    expect(remapMetaLineage(untouched, undefined)).toBe(untouched)
  })
})

describe('UndoCloseStack.remapLineage', () => {
  it('rewrites the anchors of every entry still waiting', () => {
    const stack = new UndoCloseStack(() => 10)
    stack.push({ type: 'detached', closedAt: 5, sessionMeta: meta({ linkedParentId: 'parent' }), record: row('closed', 'tab') })
    stack.remapLineage(lineage)
    expect(stack.peek()).toMatchObject({ sessionMeta: { linkedParentId: 'parent-2' }, record: { projectTabId: 'tab-2' } })
  })
})
