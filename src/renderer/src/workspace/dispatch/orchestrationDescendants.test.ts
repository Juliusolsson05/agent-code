import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'
import { resolveStrictDispatchCommandTarget } from '@renderer/workspace/dispatch/dispatchTarget'
import type { PersistedWorkspace } from '@renderer/workspace/persistence'
import type { WorkspaceState } from '@renderer/workspace/types'
import { liveWorkspaceFromPersisted } from '@renderer/workspace/workspaceShape'

// #1013 review B, MAJOR: an orchestration GRANDCHILD must get an index row.
//
// The base is the owner's real workspace (sanitized, testing/fixtures/
// workspace-v2/README.md), put through the same v2→live conversion rehydrate uses. It has one
// orchestration root with three direct children. The grandchild link is added
// by this test: none of the 36 workspace snapshots on the owner's machine had
// one, up to 29 children and all direct. The link is still reachable in the
// product, because a child that has the orchestration domain can create
// agents, and `orchestrationParentId` names the direct parent.
const ROOT = '46179162-02ed-491d-97dd-6e291392b280'
const CHILD = 'cddf53b0-0a1f-4677-bf24-0b90a17fb813'

function recordedState(): WorkspaceState {
  const file = JSON.parse(readFileSync(resolve(__dirname, '../../../../../testing/fixtures/workspace-v2/2026-09-19-live-workspace.sanitized.json'), 'utf8')) as { windows: { workspace: PersistedWorkspace }[] }
  return liveWorkspaceFromPersisted(file.windows[0]!.workspace)
}

function withGrandchild(state: WorkspaceState): WorkspaceState {
  // The grandchild is its parent's own record re-parented, so every other
  // field is one the app really persisted for an orchestration child.
  const child = state.sessions[CHILD]!
  return {
    ...state,
    sessions: { ...state.sessions, grandchild: { ...child, orchestrationParentId: CHILD, joinedAt: (child.joinedAt ?? 0) + 1 } },
  }
}

it('lists a grandchild directly under its own parent, with a label', () => {
  const rows = buildVisibleDispatchRows(withGrandchild(recordedState()))
  const ids = rows.map(row => row.sessionId)
  expect(ids).toContain('grandchild')
  expect(ids.indexOf('grandchild')).toBe(ids.indexOf(CHILD) + 1)
  const row = rows.find(item => item.sessionId === 'grandchild')!
  expect(row.depth).toBe(1)
  expect(row.label).toMatch(/^[A-Z]\d+$/)
  // Every row once: the recorded pool plus the grandchild, nothing lost or doubled.
  expect(new Set(ids).size).toBe(ids.length)
})

it('a grandchild in a lane is a command target instead of "no longer available"', () => {
  const state = withGrandchild(recordedState())
  const lanes = state.stage.lanes.map((lane, index) => (index === state.stage.focusedLane ? { ...lane, selectedSessionId: 'grandchild' } : lane))
  expect(resolveStrictDispatchCommandTarget({ ...state, stage: { ...state.stage, lanes } })?.row.sessionId).toBe('grandchild')
})

it('a parent cycle lists both rows instead of dropping them', () => {
  const state = recordedState()
  const a = state.sessions[CHILD]!
  const cyclic: WorkspaceState = {
    ...state,
    sessions: {
      ...state.sessions,
      [CHILD]: { ...a, orchestrationParentId: 'loop-b' },
      'loop-b': { ...a, orchestrationParentId: CHILD },
    },
  }
  const ids = buildVisibleDispatchRows(cyclic).map(row => row.sessionId)
  expect(ids).toContain(CHILD)
  expect(ids).toContain('loop-b')
  // The recorded root and its two other children are untouched.
  expect(ids).toContain(ROOT)
})
