import { describe, expect, it } from 'vitest'

import type { PersistedWorkspace } from '@renderer/workspace/persistence'
import type { SessionId, TabId } from '@renderer/workspace/types'
import {
  isStageWorkspace,
  migrateWorkspaceToStage,
} from '@renderer/workspace/workspaceShape'
import { ownerV2Workspace } from '@renderer/workspace/workspaceShape.ownerV2Fixture'

// The migration contract (plan 2026-09-17-unified-stage-layout.md §6, §10).
// Every fixture class here is either recorded from a real workspace.json or
// a deliberately corrupt variant of one — no imagined happy paths.

const TAB_A: TabId = 'tab-a'
const TAB_B: TabId = 'tab-b'
const S = (n: string): SessionId => `session-${n}`

function gridHeavyV2Workspace(): PersistedWorkspace {
  // A pure-grid user: multi-pane tab, no dispatchMode at all.
  return {
    tabs: [
      {
        id: TAB_A,
        title: 'app',
        focusedSessionId: S('a1'),
        root: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.66,
          a: { type: 'leaf', sessionId: S('a1') },
          b: {
            type: 'split',
            direction: 'horizontal',
            ratio: 0.5,
            a: { type: 'leaf', sessionId: S('a2') },
            b: { type: 'leaf', sessionId: S('a3') },
          },
        },
      },
      {
        id: TAB_B,
        title: 'service',
        focusedSessionId: S('b1'),
        root: { type: 'leaf', sessionId: S('b1') },
      },
    ],
    activeTabId: TAB_A,
    sessions: {
      [S('a1')]: { cwd: '/x/app', kind: 'claude' },
      [S('a2')]: { cwd: '/x/app', kind: 'claude' },
      [S('a3')]: { cwd: '/x/app', kind: 'terminal' },
      [S('b1')]: { cwd: '/x/service', kind: 'claude' },
    },
  }
}

describe('isStageWorkspace', () => {
  it('detects v3 by stage presence, not a version number', () => {
    expect(isStageWorkspace(ownerV2Workspace)).toBe(false)
    expect(
      isStageWorkspace({ ...ownerV2Workspace, stage: { lanes: [], focusedLane: 0 } }),
    ).toBe(true)
  })
})

describe('migrateWorkspaceToStage — recorded owner shape', () => {
  const migrated = migrateWorkspaceToStage(ownerV2Workspace)

  it('mints projects from tabs, keeping ids and titles', () => {
    expect(migrated.projects).toEqual([
      { id: '3bf27c7f-2e3a-4da1-a35a-e013ad86f937', title: 'alpha' },
      { id: 'e0224b91-da18-4b20-9cc0-da491569a6b5', title: 'agent-code' },
      { id: 'd3a84a9d-2993-4423-9fa4-8c6a457b4e7b', title: 'gamma' },
    ])
    expect(migrated.activeProjectId).toBe('e0224b91-da18-4b20-9cc0-da491569a6b5')
  })

  it('carries the 12-lane two-row stage over verbatim', () => {
    expect(migrated.stage.lanes).toHaveLength(12)
    expect(migrated.stage.rows).toEqual([
      { length: 6, capChildren: false, indexFraction: 0.1, height: 0.5869481693862371 },
      { length: 6, height: 0.41305183061376294, indexFraction: 0.1 },
    ])
    expect(migrated.stage.focusedLane).toBe(10)
    expect(migrated.stage.laneWeights).toHaveLength(12)
    expect(migrated.stage.lanes[10].selectedSessionId).toBe(
      '1d0db3d8-b277-4a8d-81b1-5269d76ed48a',
    )
  })

  it('resolves every pooled session to the project the v2 shape implied', () => {
    // Tab leaf → its tab.
    expect(migrated.sessions['575880c6-d447-49b8-aa9b-64705d70c287']?.projectId).toBe(
      'e0224b91-da18-4b20-9cc0-da491569a6b5',
    )
    // Detached → its recorded affinity (alpha), not the active tab.
    expect(migrated.sessions['e6e19a29-f8b4-44da-bb9a-38fcfca2a314']?.projectId).toBe(
      '3bf27c7f-2e3a-4da1-a35a-e013ad86f937',
    )
    // Lane terminals resolve through their detached record's affinity —
    // in v2 a lane never owns anything, so the record is the only source.
    expect(migrated.sessions['20c09242-4210-433b-b4cd-c0d31b47c507']?.projectId).toBe(
      'e0224b91-da18-4b20-9cc0-da491569a6b5',
    )
    // A gamma-affinity lane agent stays gamma even though the active
    // project is agent-code.
    expect(migrated.sessions['b311a9ed-62c0-4b8e-82be-b945cc46cae3']?.projectId).toBe(
      'd3a84a9d-2993-4423-9fa4-8c6a457b4e7b',
    )
    // The parked non-lane agent survives as an ordinary unplaced pool row.
    expect(migrated.sessions['c0d3f00d-51aa-4f6e-8b1d-9d2e7a4b5c6f']?.projectId).toBe(
      '3bf27c7f-2e3a-4da1-a35a-e013ad86f937',
    )
  })

  it('keeps terminal and extension-view sessions as ordinary pool citizens', () => {
    expect(migrated.sessions['20c09242-4210-433b-b4cd-c0d31b47c507']?.kind).toBe('terminal')
    expect(migrated.sessions['7327ced2-fb07-4b63-a357-50d3f94f8fb6']?.kind).toBe(
      'extension-view',
    )
  })

  it('preserves drafts for surviving sessions only', () => {
    expect(Object.keys(migrated.drafts ?? {})).toEqual([
      '361ef0c4-800b-4bb5-85f4-931183e8583a',
      '575880c6-d447-49b8-aa9b-64705d70c287',
    ])
  })
})

describe('migrateWorkspaceToStage — pure-grid workspace (no dispatchMode)', () => {
  const migrated = migrateWorkspaceToStage(gridHeavyV2Workspace())

  it('seeds lane 0 with the active tab focus and mints a [2] default stage', () => {
    expect(migrated.stage.rows).toEqual([{ length: 2 }])
    expect(migrated.stage.lanes).toEqual([
      { selectedSessionId: S('a1') },
      {},
    ])
    expect(migrated.stage.focusedLane).toBe(0)
  })

  it('ACCEPTED LOSS: pools multi-pane tab leaves instead of reconstructing them', () => {
    // a2/a3 were visible grid panes; in the pool they are alive, owned by
    // their project, and unplaced. This is the recorded plan decision, so
    // the assertion pins it rather than tolerating it.
    expect(migrated.sessions[S('a2')]?.projectId).toBe(TAB_A)
    expect(migrated.sessions[S('a3')]?.projectId).toBe(TAB_A)
    const placed = new Set(
      migrated.stage.lanes
        .map(lane => lane.selectedSessionId)
        .filter((id): id is SessionId => id !== undefined),
    )
    expect(placed.has(S('a2'))).toBe(false)
    expect(placed.has(S('a3'))).toBe(false)
    expect(placed.has(S('b1'))).toBe(false)
  })
})

describe('migrateWorkspaceToStage — seed precedence', () => {
  it('prefers dispatch focus over the active tab focus', () => {
    const base = gridHeavyV2Workspace()
    const migrated = migrateWorkspaceToStage({
      ...base,
      dispatchMode: { scope: 'project', focusedSessionId: S('b1') },
    })
    expect(migrated.stage.lanes[0]).toEqual({ selectedSessionId: S('b1') })
  })

  it('leaves lanes empty when the focused session is missing or buried', () => {
    const base = gridHeavyV2Workspace()
    const missing = migrateWorkspaceToStage({
      ...base,
      dispatchMode: { scope: 'project', focusedSessionId: S('ghost') },
    })
    expect(missing.stage.lanes).toEqual([{}, {}])

    const buried = migrateWorkspaceToStage({
      ...base,
      buried: [
        {
          id: S('a1'),
          sessionId: S('a1'),
          sessionMeta: base.sessions[S('a1')]!,
          buriedAt: 1,
          sourceTabId: TAB_A,
          sourceTabTitle: 'app',
          sourceTabIndex: 0,
        },
      ],
    })
    expect(buried.stage.lanes).toEqual([{}, {}])
  })
})

describe('migrateWorkspaceToStage — burial folds into the pool', () => {
  it('gives buried sessions pool membership with their source project', () => {
    const base = gridHeavyV2Workspace()
    const sessionId = S('a3')
    const migrated = migrateWorkspaceToStage({
      ...base,
      // Remove a3 from the tree and bury it: hidden-but-live in v2 must
      // become simply pooled-and-unplaced in v3.
      tabs: [
        {
          ...base.tabs[0]!,
          root: {
            type: 'split',
            direction: 'vertical',
            ratio: 0.66,
            a: { type: 'leaf', sessionId: S('a1') },
            b: { type: 'leaf', sessionId: S('a2') },
          },
        },
        base.tabs[1]!,
      ],
      buried: [
        {
          id: sessionId,
          sessionId,
          sessionMeta: base.sessions[sessionId]!,
          buriedAt: 2,
          sourceTabId: TAB_A,
          sourceTabTitle: 'app',
          sourceTabIndex: 0,
          direction: 'horizontal',
          ratio: 0.5,
          side: 'b',
        },
      ],
    })
    expect(migrated.sessions[sessionId]).toBeDefined()
    expect(migrated.sessions[sessionId]?.projectId).toBe(TAB_A)
  })
})

describe('migrateWorkspaceToStage — corruption repairs instead of crashing', () => {
  it('drops unowned session rows (the #258 fork-bomb guard)', () => {
    const base = gridHeavyV2Workspace()
    const migrated = migrateWorkspaceToStage({
      ...base,
      sessions: {
        ...base.sessions,
        [S('stale')]: { cwd: '/x', kind: 'claude' },
      },
    })
    expect(migrated.sessions[S('stale')]).toBeUndefined()
  })

  it('clears lane pointers whose session did not survive the pool', () => {
    const base = gridHeavyV2Workspace()
    const withLanes = {
      ...base,
      dispatchMode: {
        scope: 'global',
        tiled: {
          lanes: [{ selectedSessionId: S('a1') }, { selectedSessionId: S('stale') }],
          focusedLane: 1,
        },
      },
    }
    const migrated = migrateWorkspaceToStage({
      ...withLanes,
      sessions: { ...base.sessions, [S('stale')]: { cwd: '/x', kind: 'claude' } },
    } as PersistedWorkspace)
    expect(migrated.stage.lanes[1]).toEqual({})
  })

  it('repairs a rows/lanes length violation through normalizeGridShape', () => {
    const base = gridHeavyV2Workspace()
    const migrated = migrateWorkspaceToStage({
      ...base,
      dispatchMode: {
        scope: 'global',
        tiled: {
          lanes: [{}, {}, {}],
          rows: [{ length: 2 }, { length: 2 }], // sums to 4 ≠ 3: corrupt
          focusedLane: 0,
        },
      },
    })
    const sum = migrated.stage.rows?.reduce((acc, row) => acc + row.length, 0)
    expect(sum).toBe(migrated.stage.lanes.length)
  })

  it('drops pins that name sessions the pool does not keep', () => {
    const base = gridHeavyV2Workspace()
    const migrated = migrateWorkspaceToStage({
      ...base,
      pinnedSessionIds: [S('a1'), S('stale'), S('a1')],
    })
    expect(migrated.pinnedSessionIds).toEqual([S('a1')])
  })
})

describe('migrateWorkspaceToStage — degenerate and affinity guards', () => {
  it('migrates an empty-tab workspace to an empty pool without inventing a project', () => {
    const migrated = migrateWorkspaceToStage({
      tabs: [],
      activeTabId: 'nope',
      sessions: {},
    })
    expect(migrated.projects).toEqual([])
    expect(migrated.activeProjectId).toBe('')
    expect(migrated.stage.lanes).toEqual([{}, {}])
  })

  it('drops a detached record whose project no longer exists (v2 ownership rule)', () => {
    // A detached record naming a dead tab is an ownership island v2 already
    // rejects (sessionOwnership.ts): treating it as an owner made ghosts
    // immortal. The migration inherits that rule rather than manufacturing
    // a re-parented survivor the rest of the system never agreed to own.
    const base = gridHeavyV2Workspace()
    const migrated = migrateWorkspaceToStage({
      ...base,
      detachedSessions: {
        [S('a2')]: {
          sessionId: S('a2'),
          surface: 'dispatch',
          projectTabId: 'tab-ghost',
          projectTabTitle: 'ghost',
          projectTabIndex: 9,
          detachedAt: 3,
        },
      },
      // Remove a2 from the tree so the corrupt record is its only owner.
      tabs: [
        {
          ...base.tabs[0]!,
          root: {
            type: 'split',
            direction: 'vertical',
            ratio: 0.5,
            a: { type: 'leaf', sessionId: S('a1') },
            b: { type: 'leaf', sessionId: S('a3') },
          },
        },
        base.tabs[1]!,
      ],
    })
    expect(migrated.sessions[S('a2')]).toBeUndefined()
  })

  it('re-parents a buried session whose source project is gone to the active project', () => {
    // Buried ownership is unconditional in v2 (sessionOwnership adds every
    // buried id), so a buried record naming a dead tab CAN reach the
    // migration. The affinity guard must not emit a dangling projectId —
    // in v3 that would filter the session out of every index forever.
    const base = gridHeavyV2Workspace()
    const sessionId = S('a3')
    const migrated = migrateWorkspaceToStage({
      ...base,
      tabs: [
        {
          ...base.tabs[0]!,
          root: {
            type: 'split',
            direction: 'vertical',
            ratio: 0.5,
            a: { type: 'leaf', sessionId: S('a1') },
            b: { type: 'leaf', sessionId: S('a2') },
          },
        },
        base.tabs[1]!,
      ],
      buried: [
        {
          id: sessionId,
          sessionId,
          sessionMeta: base.sessions[sessionId]!,
          buriedAt: 4,
          sourceTabId: 'tab-ghost',
          sourceTabTitle: 'ghost',
          sourceTabIndex: 9,
        },
      ],
    })
    expect(migrated.sessions[sessionId]?.projectId).toBe(TAB_A)
  })
})
