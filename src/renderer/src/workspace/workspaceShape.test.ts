import { describe, expect, it } from 'vitest'

import type { PersistedWorkspace } from '@renderer/workspace/persistence'
import type { SessionId, TabId } from '@renderer/workspace/types'
import {
  isStageWorkspace,
  liveWorkspaceFromPersisted,
  migrateWorkspaceToStage,
} from '@renderer/workspace/workspaceShape'
import { resolveTabSessions } from '@renderer/workspace/queries'
import { collectOwnedSessionIds } from '@renderer/workspace/sessionOwnership'
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

// The entry seed (#977) has exactly one home now. It used to be applied by the
// `enterTiledDispatch` action every time the user turned Grid Dispatch on, and
// dispatch/entryContinuity.renderer.test.tsx pinned it there — including four
// wake-ordering cases (#690 parity), because that action placed a possibly
// hibernated agent into a lane and had to wake it first. #992 deleted the
// action: a workspace is never "entered", it is MIGRATED once, here. The wake
// cases have no successor on purpose — migration runs at boot and writes no
// live placement: the lane's leaf owns the wake (a terminal on mount, an agent
// on its first send, #691), so there is no reducer here that would need to
// order a wake before a write. unifiedStage.integration.test.ts
// covers the boot half (a seeded hibernated session is named, never spawned).
describe('migrateWorkspaceToStage — seed precedence', () => {
  it('seeds ONLY lane 0 — continuity, never #681 auto-fill', () => {
    const migrated = migrateWorkspaceToStage(gridHeavyV2Workspace())
    expect(migrated.stage.lanes[0]).toEqual({ selectedSessionId: S('a1') })
    // Three other live sessions exist and none of them is handed a lane.
    expect(migrated.stage.lanes.slice(1)).toEqual([{}])
    // The seeded lane is the focused lane, so the user keeps commanding the
    // agent they were commanding.
    expect(migrated.stage.focusedLane).toBe(0)
  })

  it('names a hibernated (detached) seed instead of dropping it', () => {
    // The classic-Dispatch focus usually WAS a detached agent. It has no
    // backend at boot; the lane must still name it, because the lane's leaf
    // is what wakes it. Dropping it would land the user on an empty stage
    // with their agent one index-click away for no reason.
    const base = gridHeavyV2Workspace()
    const migrated = migrateWorkspaceToStage({
      ...base,
      sessions: { ...base.sessions, [S('parked')]: { cwd: '/x/app/.worktrees/t', kind: 'codex' } },
      detachedSessions: {
        [S('parked')]: {
          sessionId: S('parked'), surface: 'dispatch', projectTabId: TAB_A,
          projectTabTitle: 'app', projectTabIndex: 0, detachedAt: 5,
        },
      },
      dispatchMode: { scope: 'global', focusedSessionId: S('parked') },
    })
    expect(migrated.stage.lanes).toEqual([{ selectedSessionId: S('parked') }, {}])
  })

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
          ...base.tabs![0]!,
          root: {
            type: 'split',
            direction: 'vertical',
            ratio: 0.66,
            a: { type: 'leaf', sessionId: S('a1') },
            b: { type: 'leaf', sessionId: S('a2') },
          },
        },
        base.tabs![1]!,
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
          ...base.tabs![0]!,
          root: {
            type: 'split',
            direction: 'vertical',
            ratio: 0.5,
            a: { type: 'leaf', sessionId: S('a1') },
            b: { type: 'leaf', sessionId: S('a3') },
          },
        },
        base.tabs![1]!,
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
          ...base.tabs![0]!,
          root: {
            type: 'split',
            direction: 'vertical',
            ratio: 0.5,
            a: { type: 'leaf', sessionId: S('a1') },
            b: { type: 'leaf', sessionId: S('a2') },
          },
        },
        base.tabs![1]!,
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

describe('migrateWorkspaceToStage — buried sessions become parked pool rows', () => {
  // Bury / Revive were deleted (#992 stage 3a). These pin the read-boundary
  // rule that keeps an old file's buried sessions reachable without them.
  // (Until stage 3b-ii a separate `foldBuriedIntoDetached` pass did this by
  // minting detached records; the migration now files them directly.)
  const buriedRecord = (sessionId: SessionId, sourceTabId: TabId, buriedAt = 7) => ({
    id: sessionId,
    sessionId,
    sessionMeta: { cwd: '/x/hidden', kind: 'codex' as const },
    buriedAt,
    sourceTabId,
    sourceTabTitle: 'app',
    sourceTabIndex: 0,
  })

  it('files a buried session under its source project, ordered by when it left the screen', () => {
    const base = gridHeavyV2Workspace()
    const migrated = migrateWorkspaceToStage({ ...base, buried: [buriedRecord(S('hidden'), TAB_B, 42)] })
    // A buried record can carry the ONLY copy of its metadata.
    expect(migrated.sessions[S('hidden')]).toEqual({
      cwd: '/x/hidden', kind: 'codex', projectId: TAB_B, joinedAt: 42,
    })
  })

  it('re-parents a buried session whose source project is gone instead of orphaning it', () => {
    // v2 kept buried sessions unconditionally; treating a dead source project
    // like a dead detached project would be silent data loss on upgrade.
    const base = gridHeavyV2Workspace()
    const migrated = migrateWorkspaceToStage({ ...base, buried: [buriedRecord(S('hidden'), 'tab-ghost')] })
    expect(migrated.sessions[S('hidden')]?.projectId).toBe(TAB_A)
    expect(collectOwnedSessionIds(liveWorkspaceFromPersisted({ ...base, buried: [buriedRecord(S('hidden'), 'tab-ghost')] }))
      .has(S('hidden'))).toBe(true)
  })

  it('never gives a session a second owner', () => {
    // Also a tile leaf: the leaf wins, and its own metadata is kept.
    const base = gridHeavyV2Workspace()
    const migrated = migrateWorkspaceToStage({ ...base, buried: [buriedRecord(S('a1'), TAB_B)] })
    expect(migrated.sessions[S('a1')]).toEqual({ ...base.sessions[S('a1')], projectId: TAB_A, joinedAt: 0 })
  })
})

describe('migrateWorkspaceToStage — index order survives the merge', () => {
  it('lists a project as v2 did: tree leaves depth-first, then parked agents oldest-first', () => {
    const base = gridHeavyV2Workspace()
    const persisted: PersistedWorkspace = {
      ...base,
      sessions: {
        ...base.sessions,
        [S('late')]: { cwd: '/x/app', kind: 'codex' },
        [S('early')]: { cwd: '/x/app', kind: 'codex' },
      },
      detachedSessions: {
        [S('late')]: { sessionId: S('late'), surface: 'dispatch', projectTabId: TAB_A, projectTabTitle: 'app', projectTabIndex: 0, detachedAt: 900 },
        [S('early')]: { sessionId: S('early'), surface: 'dispatch', projectTabId: TAB_A, projectTabTitle: 'app', projectTabIndex: 0, detachedAt: 400 },
      },
    }
    expect(resolveTabSessions(liveWorkspaceFromPersisted(persisted), TAB_A))
      .toEqual([S('a1'), S('a2'), S('a3'), S('early'), S('late')])
  })
})

describe('migrateWorkspaceToStage — v3 and hybrid files', () => {
  const v3 = (): PersistedWorkspace => ({
    projects: [{ id: TAB_A, title: 'app' }, { id: TAB_B, title: 'service' }],
    activeProjectId: TAB_B,
    stage: { lanes: [{ selectedSessionId: S('b1') }, {}], rows: [{ length: 2 }], focusedLane: 1 },
    sessions: {
      [S('a1')]: { cwd: '/x/app', kind: 'claude', projectId: TAB_A, joinedAt: 10 },
      [S('b1')]: { cwd: '/x/service', kind: 'claude', projectId: TAB_B, joinedAt: 20 },
    },
    pinnedSessionIds: [S('b1')],
  })

  it('is the identity on a healthy v3 file', () => {
    const file = v3()
    const migrated = migrateWorkspaceToStage(file)
    expect(migrated.projects).toEqual(file.projects)
    expect(migrated.activeProjectId).toBe(TAB_B)
    expect(migrated.sessions).toEqual(file.sessions)
    expect(migrated.stage).toEqual(file.stage)
    expect(migrated.pinnedSessionIds).toEqual([S('b1')])
    // Running it again changes nothing: rehydrate and adoption both call it,
    // and a file is read many more times than it is upgraded.
    expect(migrateWorkspaceToStage({ ...migrated })).toEqual(migrated)
  })

  it('drops a v3 row whose project is gone, and its lane and pin with it', () => {
    // The pool's form of the v2 ghost rule. It must NOT fall back to the
    // active project: that is how 82 dead records would become 82 rows in
    // someone's index, one click from being spawned.
    const file = v3()
    file.sessions[S('ghost')] = { cwd: '/x/gone', kind: 'claude', projectId: 'tab-closed', joinedAt: 5 }
    file.stage = { lanes: [{ selectedSessionId: S('ghost') }], rows: [{ length: 1 }], focusedLane: 0 }
    file.pinnedSessionIds = [S('ghost'), S('b1')]
    const migrated = migrateWorkspaceToStage(file)

    expect(migrated.sessions).not.toHaveProperty(S('ghost'))
    expect(migrated.stage.lanes).toEqual([{}])
    expect(migrated.pinnedSessionIds).toEqual([S('b1')])
  })

  it('drops a v3 row that was never filed', () => {
    const file = v3()
    file.sessions[S('unfiled')] = { cwd: '/x/app', kind: 'claude' }
    expect(migrateWorkspaceToStage(file).sessions).not.toHaveProperty(S('unfiled'))
  })

  it('prefers the row s own stamp over the v2 owners in a hybrid file', () => {
    // The intermediate #992 builds wrote both halves. The stamp is the newer
    // fact: here a1 was re-filed under the second project after the v2 half
    // was last meaningful.
    const base = gridHeavyV2Workspace()
    const hybrid: PersistedWorkspace = {
      ...base,
      sessions: { ...base.sessions, [S('a1')]: { ...base.sessions[S('a1')]!, projectId: TAB_B } },
    }
    const migrated = migrateWorkspaceToStage(hybrid)
    expect(migrated.sessions[S('a1')]?.projectId).toBe(TAB_B)
    // No `joinedAt` was stamped, so its v2 position (first tile leaf) is kept.
    expect(migrated.sessions[S('a1')]?.joinedAt).toBe(0)
  })
})
