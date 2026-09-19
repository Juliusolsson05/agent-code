import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { PersistedWorkspace } from '@renderer/workspace/types'
import { migrateWorkspaceToStage } from '@renderer/workspace/workspaceShape'

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
