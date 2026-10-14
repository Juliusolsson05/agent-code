import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  collectOwnedSessionIds,
  collectPersistableSessionIds,
  isSidekickSession,
  pruneSessionOwnership,
} from '@renderer/workspace/sessionOwnership'
import { fileSessionAsSidekick, inheritedMembership } from '@renderer/workspace/pool'
import type { SessionMeta, TiledDispatchState, WorkspaceState } from '@renderer/workspace/types'

// The second ownership fact (#1493). Driven by the real 2026-10-14 window
// slice and the Hermes sidekick record built from its own row
// (testing/fixtures/workspace-v3/README.md). The two halves of the contract:
// a sidekick row is OWNED (so Reload Agent, Reload All and wake work on it)
// and NOT PERSISTABLE (main's index is its durable copy, plan I1).

const FIXTURES = join(process.cwd(), 'testing/fixtures/workspace-v3')
const mutated = JSON.parse(readFileSync(join(FIXTURES, '2026-10-14-live-workspace-with-sidekicks.mutated.json'), 'utf8')) as {
  windows: Array<{ workspace: { projects: Array<{ id: string; title: string }>; sessions: Record<string, SessionMeta>; stage: TiledDispatchState } }>
  sidekicks: { records: Array<{ id: string; sessionId: string; meta: SessionMeta }> }
}

function stateWithHeldSidekick(): WorkspaceState & { sidekickSessionId: string } {
  const slice = mutated.windows[0]!.workspace
  const hermes = mutated.sidekicks.records[1]!
  return {
    tabs: slice.projects,
    activeTabId: slice.projects[0]!.id,
    stage: slice.stage,
    pinnedSessionIds: [],
    sessions: { ...slice.sessions, [hermes.sessionId]: hermes.meta },
    sidekickSessionId: hermes.sessionId,
  }
}

describe('sidekick ownership', () => {
  it('owns a held sidekick row but never persists it', () => {
    const state = stateWithHeldSidekick()
    expect(isSidekickSession(state.sessions[state.sidekickSessionId])).toBe(true)
    expect(collectOwnedSessionIds(state).has(state.sidekickSessionId)).toBe(true)
    expect(collectPersistableSessionIds(state).has(state.sidekickSessionId)).toBe(false)

    const pruned = pruneSessionOwnership(state)
    // Owned: no "dropping unowned sessions" for it, and it stays in memory.
    expect(pruned.droppedSessionIds).not.toContain(state.sidekickSessionId)
    expect(pruned.sessions[state.sidekickSessionId]).toBeDefined()
    // Not persisted: the slice autosave writes has every real row but it.
    expect(pruned.persistedSessions[state.sidekickSessionId]).toBeUndefined()
    expect(Object.keys(pruned.persistedSessions).sort()).toEqual(Object.keys(mutated.windows[0]!.workspace.sessions).sort())
  })

  it('scrubs a lane that names a sidekick, so the file never points at one', () => {
    const state = stateWithHeldSidekick()
    const lanes = state.stage.lanes.map((lane, index) => (index === 0 ? { ...lane, selectedSessionId: state.sidekickSessionId } : lane))
    const pruned = pruneSessionOwnership({ ...state, stage: { ...state.stage, lanes } })
    expect(pruned.stage.lanes[0]!.selectedSessionId).toBeUndefined()
  })

  it('files a spawned row as a sidekick, never both a sidekick and a project member', () => {
    const slice = mutated.windows[0]!.workspace
    const [someId, someMeta] = Object.entries(slice.sessions)[0]!
    const filed = fileSessionAsSidekick({ [someId]: someMeta }, someId, '00000000-0000-4000-8000-0000000000aa')
    expect(filed[someId]).toMatchObject({ sidekickId: '00000000-0000-4000-8000-0000000000aa' })
    expect(filed[someId]!.projectId).toBeUndefined()
    expect(filed[someId]!.joinedAt).toBeUndefined()
  })

  it('hands a replacement the sidekick membership, not a project', () => {
    const hermes = mutated.sidekicks.records[1]!.meta
    expect(inheritedMembership(hermes)).toEqual({ sidekickId: hermes.sidekickId })
  })
})
