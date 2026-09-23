import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { PersistedWorkspace } from '@renderer/workspace/persistence'
import { liveWorkspaceFromPersisted, migrateWorkspaceToStage } from '@renderer/workspace/workspaceShape'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'

import { buildWatchPlan, isInside } from './watchPlan'

// The owner's recorded workspace: 27 sessions across three projects, one
// tmux terminal in /fixture/project-2 (sanitized paths).
const root = resolve(__dirname, '../../../../../..')
const live = (): WorkspaceState => liveWorkspaceFromPersisted(migrateWorkspaceToStage((JSON.parse(readFileSync(resolve(root, 'testing/fixtures/workspace-v2/2026-09-19-live-workspace.sanitized.json'), 'utf8')) as { windows: { workspace: PersistedWorkspace }[] }).windows[0]!.workspace) as unknown as PersistedWorkspace)

describe('watch plan on the recorded workspace', () => {
  const state = live()
  const terminal = Object.entries(state.sessions).find(([, m]) => m.kind === 'terminal')!
  const laneAgents = state.stage.lanes.map(l => l.selectedSessionId).filter(Boolean) as SessionId[]

  it('watches exactly the agents shown in lanes (terminals are attributed, never watched)', () => {
    const plan = buildWatchPlan({ state, runtimes: {}, spotlightSessionId: null })
    const expected = laneAgents.filter(id => state.sessions[id]?.kind !== 'terminal')
    expect(plan.map(p => p.sessionId).sort()).toEqual([...new Set(expected)].sort())
  })

  it('gives the recorded tmux terminal to agents of its project whose cwd contains it, by tmuxName', () => {
    const [, term] = terminal
    const sameDirAgents = Object.entries(state.sessions).filter(([, m]) => m.kind !== 'terminal' && m.projectId === term.projectId && m.cwd === term.cwd).map(([id]) => id as SessionId)
    expect(sameDirAgents.length).toBeGreaterThan(0)
    const plan = buildWatchPlan({ state: { ...state, stage: { ...state.stage, lanes: sameDirAgents.map(id => ({ selectedSessionId: id })) } }, runtimes: {}, spotlightSessionId: null })
    for (const p of plan) expect(p.tmuxNames).toEqual([term.tmuxName])
  })

  it('an agent in a worktree does not get a terminal from the main checkout, even with the same spawn cwd', () => {
    const [, term] = terminal
    const agent = Object.entries(state.sessions).find(([, m]) => m.kind !== 'terminal' && m.projectId === term.projectId && m.cwd === term.cwd)![0] as SessionId
    const runtimes = { [agent]: { workContext: { worktreePath: `${term.cwd}/.worktrees/feat-x` } } as unknown as SessionRuntime }
    const plan = buildWatchPlan({ state: { ...state, stage: { ...state.stage, lanes: [{ selectedSessionId: agent }] } }, runtimes, spotlightSessionId: null })
    expect(plan[0]!.tmuxNames).toEqual([])
  })

  it('follows the terminal\'s live cwd over its spawn cwd (the user cd\'d into the worktree)', () => {
    const [termId, term] = terminal
    const agent = Object.entries(state.sessions).find(([, m]) => m.kind !== 'terminal' && m.projectId === term.projectId)![0] as SessionId
    const worktree = `${term.cwd}/.worktrees/feat-x`
    const runtimes = {
      [agent]: { workContext: { worktreePath: worktree } } as unknown as SessionRuntime,
      [termId]: { terminalForeground: { cwd: `${worktree}/apps/web`, busy: true, command: 'node', changedAt: 0 } } as unknown as SessionRuntime,
    }
    const plan = buildWatchPlan({ state: { ...state, stage: { ...state.stage, lanes: [{ selectedSessionId: agent }] } }, runtimes, spotlightSessionId: null })
    expect(plan[0]!.tmuxNames).toEqual([term.tmuxName])
  })

  it('also watches the Spotlight agent and any agent with a pocket, even outside lanes', () => {
    const outside = Object.keys(state.sessions).find(id => !laneAgents.includes(id as SessionId) && state.sessions[id]!.kind !== 'terminal') as SessionId
    const plan = buildWatchPlan({ state: { ...state, stage: { ...state.stage, lanes: [] } }, runtimes: {}, spotlightSessionId: outside })
    expect(plan.map(p => p.sessionId)).toEqual([outside])
  })
})

it('path containment respects segment boundaries', () => {
  expect(isInside('/w/app', '/w/app')).toBe(true)
  expect(isInside('/w/app/src', '/w/app')).toBe(true)
  expect(isInside('/w/app2', '/w/app')).toBe(false)
})
