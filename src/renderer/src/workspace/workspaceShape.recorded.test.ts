import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { PersistedWorkspace } from '@renderer/workspace/persistence'
import { MalformedWorkspaceContainerError, migrateWorkspaceToStage } from '@renderer/workspace/workspaceShape'

// v2→v3 migration on REAL persisted workspaces (#992 review A).
//
// The existing migration tests use a generated 82-row loop and a hand-trimmed
// literal. Review A reproduced correct behaviour on real files in a scratch
// probe, but nothing in the repo pinned it. The inputs here are two real
// persisted v2 documents:
//   - testing/fixtures/workspace-v2/2026-09-19-live-workspace.sanitized.json:
//     the owner's live workspace.json (27 sessions, 24 of them parked in
//     Dispatch, one terminal with a live tmuxName), sanitized per its README;
//   - testing/fixtures/worktree-context/dispatch-global-d23.json: a recorded
//     global-Dispatch workspace (4 tabs, 24 rows), see that folder's MANIFEST.
//
// The contract is the one that makes the migration safe to ship: every
// session the v2 autosave would keep survives, with the fields that carry
// identity unchanged. If a terminal's tmuxName were lost, #933's startup
// recovery would treat the session as an orphan and kill it. The migration
// must also be idempotent, because rehydrate and the window handoff both run
// it, possibly on a document that is already v3.

const root = resolve(__dirname, '../../../..')
const liveWorkspace = (): PersistedWorkspace =>
  (JSON.parse(readFileSync(resolve(root, 'testing/fixtures/workspace-v2/2026-09-19-live-workspace.sanitized.json'), 'utf8')) as { windows: { workspace: PersistedWorkspace }[] }).windows[0]!.workspace
const dispatchWorkspace = (): PersistedWorkspace =>
  (JSON.parse(readFileSync(resolve(root, 'testing/fixtures/worktree-context/dispatch-global-d23.json'), 'utf8')) as { state: PersistedWorkspace }).state

// Fields that give a session its identity and its link to live processes and
// providers. Layout lives elsewhere (tabs, lanes), so it is not compared here.
const IDENTITY_FIELDS = [
  'kind', 'cwd', 'title', 'tmuxName', 'providerSessionId', 'providerSessionIdSource',
  'agentNameId', 'tldrIdentity', 'orchestrationParentId', 'orchestrationRootId', 'orchestrationRole',
  'builtInMcpDomains', 'builtInMcpOverrides', 'providerRuntime',
] as const

describe.each([
  ['the owner\'s live workspace', liveWorkspace],
  ['a recorded global-Dispatch workspace', dispatchWorkspace],
])('v2→v3 migration of %s', (_label, load) => {
  it('keeps every session with its identity fields unchanged', () => {
    const v2 = load()
    const stage = migrateWorkspaceToStage(v2)
    const v2Sessions = v2.sessions as Record<string, Record<string, unknown>>
    expect(Object.keys(stage.sessions).sort()).toEqual(Object.keys(v2Sessions).sort())
    for (const [id, before] of Object.entries(v2Sessions)) {
      const after = stage.sessions[id] as unknown as Record<string, unknown>
      for (const field of IDENTITY_FIELDS) {
        if (field in before) expect({ id, field, value: after[field] }).toEqual({ id, field, value: before[field] })
      }
      // Every row lands in a live project: "owned iff its projectId names a
      // live project" is the rule that decides what the pool keeps.
      expect(stage.projects.some(project => project.id === after.projectId)).toBe(true)
    }
  })

  it('is idempotent: migrating the migrated document changes nothing', () => {
    const once = migrateWorkspaceToStage(load())
    const twice = migrateWorkspaceToStage(JSON.parse(JSON.stringify(once)) as PersistedWorkspace)
    expect(twice).toEqual(once)
  })
})

it('keeps the live terminal\'s tmuxName, the reference startup recovery matches on', () => {
  const v2 = liveWorkspace()
  const terminals = Object.entries(v2.sessions as Record<string, { kind: string, tmuxName?: string }>)
    .filter(([, meta]) => meta.kind === 'terminal' && meta.tmuxName)
  expect(terminals.length).toBeGreaterThan(0)
  const stage = migrateWorkspaceToStage(v2)
  for (const [id, meta] of terminals) expect((stage.sessions[id] as { tmuxName?: string }).tmuxName).toBe(meta.tmuxName)
})

// #1245: one malformed stage entry used to throw inside the migration
// (`Cannot read properties of null (reading 'selectedSessionId')`), which put
// startup into the locked single-tab recovery shell with none of the user's
// agents shown. Verified on the owner's real v3 workspace below. A lane or row
// holds layout only, never a session, so it is repaired per entry instead.
const liveV3Workspace = (): PersistedWorkspace =>
  (JSON.parse(readFileSync(resolve(root, 'testing/fixtures/workspace-v3/2026-09-20-live-workspace.sanitized.json'), 'utf8')) as { windows: { workspace: PersistedWorkspace }[] }).windows[0]!.workspace

describe('malformed stage entries in a real v3 workspace (#1245)', () => {
  it('keeps every agent and the other lane when one lane is null', () => {
    const workspace = liveV3Workspace()
    const stage = workspace.stage as unknown as { lanes: unknown[] }
    const survivor = (stage.lanes[1] as { selectedSessionId: string }).selectedSessionId
    stage.lanes[0] = null
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const migrated = migrateWorkspaceToStage(workspace)
    // The repair is reported, with how many entries it replaced.
    expect(warn).toHaveBeenCalledWith('[workspace] replaced malformed stage lanes with empty slots', { count: 1 })
    warn.mockRestore()
    expect(Object.keys(migrated.sessions).sort()).toEqual(Object.keys(workspace.sessions ?? {}).sort())
    // The slot stays (lane indices, weights and focus keep their meaning),
    // empty, and the other lane keeps its agent.
    expect(migrated.stage.lanes).toEqual([{}, { selectedSessionId: survivor }])
  })

  it('keeps every agent and both lanes when a row is null', () => {
    const workspace = liveV3Workspace()
    ;(workspace.stage as unknown as { rows: unknown[] }).rows[0] = null
    const migrated = migrateWorkspaceToStage(workspace)
    expect(Object.keys(migrated.sessions)).toHaveLength(Object.keys(workspace.sessions ?? {}).length)
    expect(migrated.stage.lanes).toHaveLength(2)
    expect((migrated.stage.rows ?? []).reduce((sum, row) => sum + row.length, 0)).toBe(2)
  })

  it('keeps every agent and both lanes when the rows container itself is not a list', () => {
    const workspace = liveV3Workspace()
    ;(workspace.stage as unknown as { rows: unknown }).rows = 5
    const migrated = migrateWorkspaceToStage(workspace)
    expect(Object.keys(migrated.sessions)).toHaveLength(Object.keys(workspace.sessions ?? {}).length)
    expect(migrated.stage.lanes).toHaveLength(2)
    expect(migrated.stage.rows).toEqual([{ length: 2 }])
  })

  it('keeps every agent when the lanes container itself is not a list', () => {
    const workspace = liveV3Workspace()
    ;(workspace.stage as unknown as { lanes: unknown }).lanes = 5
    const migrated = migrateWorkspaceToStage(workspace)
    expect(Object.keys(migrated.sessions)).toHaveLength(Object.keys(workspace.sessions ?? {}).length)
    expect(migrated.stage.lanes.length).toBeGreaterThan(0)
  })
})

// The same issue's v2 shapes, on the owner's real v2 workspace (steering q16).
// An ENTRY that holds nothing is repaired; a present-but-malformed CONTAINER
// that may hold the only copy of an agent keeps rule 8's deliberate lock.
describe('malformed entries and containers in a real v2 workspace (#1245)', () => {
  // Steering q21 / review A: a damaged entry REPLACING a real tab or project
  // is the shape where agents are at stake (their placement names its id).
  it.each([
    ['v2 tab replaced by null', () => { const w = liveWorkspace(); (w.tabs as unknown[])[1] = null; return w }],
    ['v2 tab with its id removed', () => { const w = liveWorkspace(); delete (w.tabs as Array<{ id?: string }>)[1]!.id; return w }],
    ['v2 extra null tab', () => { const w = liveWorkspace(); (w.tabs as unknown[]).push(null); return w }],
    ['v3 project replaced by null', () => { const w = liveV3Workspace(); (w.projects as unknown[])[1] = null; return w }],
  ])('locks instead of dropping agents when a %s', (_label, damaged) => {
    expect(() => migrateWorkspaceToStage(damaged())).toThrow(MalformedWorkspaceContainerError)
  })

  it('migrates a file with no sessions map at all instead of throwing', () => {
    const workspace = liveWorkspace()
    delete (workspace as { sessions?: unknown }).sessions
    expect(() => migrateWorkspaceToStage(workspace)).not.toThrow()
  })

  it.each([
    ['buried', (workspace: Record<string, unknown>) => { workspace.buried = {} }],
    ['sessions', (workspace: Record<string, unknown>) => { workspace.sessions = 5 }],
    ['sessions (a list)', (workspace: Record<string, unknown>) => { workspace.sessions = [] }],
    // The only owner of 24 of the 27 real agents: migrating it as empty
    // dropped them all and reported a complete restore (#1256 review).
    ['detachedSessions (a number)', (workspace: Record<string, unknown>) => { workspace.detachedSessions = 5 }],
    ['detachedSessions (a list)', (workspace: Record<string, unknown>) => { workspace.detachedSessions = [null] }],
  ])('refuses a present-but-malformed %s container with the typed lock, never an empty pool', (_field, damage) => {
    const workspace = liveWorkspace() as unknown as Record<string, unknown>
    damage(workspace)
    expect(() => migrateWorkspaceToStage(workspace as unknown as PersistedWorkspace)).toThrow(MalformedWorkspaceContainerError)
  })
})

describe('damaged v2 placements and v3 rows keep every agent where it was (#1256 review)', () => {
  it('re-homes the agent of a damaged detached entry instead of dropping it', () => {
    const workspace = liveWorkspace()
    const detached = workspace.detachedSessions as Record<string, unknown>
    const damaged = Object.keys(detached)[0]!
    detached[damaged] = null
    const migrated = migrateWorkspaceToStage(workspace)
    expect(Object.keys(migrated.sessions)).toHaveLength(27)
    expect(migrated.sessions[damaged]?.projectId).toBe(workspace.activeTabId)
  })

  it("gives a null row's lanes an unbound row of their own, not the next row's project", () => {
    const workspace = liveV3Workspace()
    const stage = workspace.stage as unknown as { lanes: unknown[]; rows: unknown[]; laneWeights?: unknown }
    const second = (workspace.projects as Array<{ id: string }>)[1]!.id
    stage.lanes.push({})
    delete stage.laneWeights
    stage.rows = [null, { length: 1, projectTabIds: [second] }]
    const migrated = migrateWorkspaceToStage(workspace)
    expect(migrated.stage.rows).toEqual([{ length: 2 }, { length: 1, projectTabIds: [second] }])
  })

  it("keeps an intact v2 envelope's layout when the v3 stage beside it has unusable lanes", () => {
    const workspace = liveWorkspace()
    const envelopeLanes = (workspace.dispatchMode as { tiled: { lanes: unknown[] } }).tiled.lanes.length
    ;(workspace as { stage?: unknown }).stage = { lanes: 5, rows: [], focusedLane: 0 }
    expect(migrateWorkspaceToStage(workspace).stage.lanes).toHaveLength(envelopeLanes)
  })
})
