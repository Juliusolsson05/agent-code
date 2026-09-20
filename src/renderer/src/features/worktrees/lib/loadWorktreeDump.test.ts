import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { collectLiveAgentsByWorktree } from '@renderer/features/worktrees/lib/loadWorktreeDump'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { WorkspaceState } from '@renderer/workspace/types'
import { asRecord } from '@shared/lib/asRecord'
import {
  deriveAgentWorkContext,
  ingestWorktreeRawEvent,
} from '@shared/work-context/tracker'
import type { WorktreeActivityState } from '@shared/work-context/types'
import type { GitWorktreeStatus } from '@shared/types/git'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'

const MAIN_CHECKOUT = '/fixture/project-1'
const LINKED_WORKTREE = `${MAIN_CHECKOUT}/.worktrees/worktree-1`
const SESSION_ID = 'recorded-codex-session'

function recordedCodexRecords(): Array<Record<string, unknown>> {
  const path = resolve(
    process.cwd(),
    'testing/fixtures/worktree-context/codex-main-to-worktree.json',
  )
  const fixture = asRecord(JSON.parse(readFileSync(path, 'utf8')))
  if (!fixture || !Array.isArray(fixture.records)) {
    throw new Error('codex-main-to-worktree fixture has no records array')
  }
  return fixture.records as Array<Record<string, unknown>>
}

function status(
  path: string,
  branch: string,
  category: GitWorktreeStatus['category'],
): GitWorktreeStatus {
  return {
    path,
    branch,
    head: null,
    detached: false,
    dirty: false,
    mergedToMain: null,
    ahead: null,
    behind: null,
    patchUniqueAhead: null,
    lastCommitAt: null,
    lastCommitRelative: null,
    category,
  }
}

describe('collectLiveAgentsByWorktree recorded context', () => {
  it('[codex-main-to-worktree] places the live agent at the worktree derived by replay', () => {
    const worktrees = [
      status(MAIN_CHECKOUT, 'fixture/branch-1', 'main'),
      status(LINKED_WORKTREE, 'fixture/worktree-branch', 'active-unmerged'),
    ]
    let workActivity: WorktreeActivityState | null = null
    for (const raw of recordedCodexRecords()) {
      workActivity = ingestWorktreeRawEvent({
        state: workActivity,
        raw,
        worktrees,
        sessionCwd: MAIN_CHECKOUT,
      })
    }

    // WHY runtime context is derived from fixture replay here: assigning
    // active/primary by hand would make the consumer test green even if the
    // provider adapter—the substrate that caused #658—still emitted nothing.
    const runtime = {
      workActivity,
      workContext: deriveAgentWorkContext(workActivity),
      sessionStatus: 'running',
      streamPhase: 'idle',
    } as unknown as SessionRuntime
    const state = {
      tabs: [{
        id: 'tab-recorded',
        title: 'Recorded project',
      }],
      activeTabId: 'tab-recorded',
      stage: oneLaneStage(SESSION_ID),
      sessions: {
        [SESSION_ID]: { cwd: MAIN_CHECKOUT, kind: 'codex', projectId: 'tab-recorded', joinedAt: 0 },
      },
      pinnedSessionIds: [],
    } as WorkspaceState
    const workspace = {
      state,
      runtimes: { [SESSION_ID]: runtime },
    } as unknown as Workspace

    const liveByWorktree = collectLiveAgentsByWorktree(workspace, worktrees)

    expect(liveByWorktree.get(LINKED_WORKTREE)?.map(agent => agent.sessionId))
      .toEqual([SESSION_ID])
    expect(liveByWorktree.get(MAIN_CHECKOUT) ?? []).toEqual([])
  })

  it('groups by active checkout when historical primary still points at main', () => {
    const worktrees = [
      status(MAIN_CHECKOUT, 'fixture/branch-1', 'main'),
      status(LINKED_WORKTREE, 'fixture/worktree-branch', 'active-unmerged'),
    ]
    let workActivity: WorktreeActivityState | null = null
    for (const raw of recordedCodexRecords()) {
      workActivity = ingestWorktreeRawEvent({
        state: workActivity,
        raw,
        worktrees,
        sessionCwd: MAIN_CHECKOUT,
      })
    }
    if (!workActivity?.active) throw new Error('recorded replay has no active context')
    const divergentActivity: WorktreeActivityState = {
      ...workActivity,
      // WHY force the semantic disagreement rather than inventing an entire
      // state: recorded replay proves the active Codex transition, while this
      // one override captures the documented primary/active split that the
      // Worktrees surface must resolve in favor of the current checkout.
      primary: {
        worktreePath: MAIN_CHECKOUT,
        branch: 'fixture/branch-1',
        repoRoot: MAIN_CHECKOUT,
        confidence: 'fallback',
        source: 'fixture:historical-primary',
        updatedAt: workActivity.updatedAt,
      },
    }
    const runtime = {
      workActivity: divergentActivity,
      workContext: deriveAgentWorkContext(divergentActivity),
      sessionStatus: 'running',
      streamPhase: 'idle',
    } as unknown as SessionRuntime
    const state = {
      tabs: [{
        id: 'tab-divergent',
        title: 'Divergent project',
      }],
      activeTabId: 'tab-divergent',
      stage: oneLaneStage(SESSION_ID),
      sessions: {
        [SESSION_ID]: { cwd: MAIN_CHECKOUT, kind: 'codex', projectId: 'tab-divergent', joinedAt: 0 },
      },
      pinnedSessionIds: [],
    } as WorkspaceState
    const workspace = {
      state,
      runtimes: { [SESSION_ID]: runtime },
    } as unknown as Workspace

    const liveByWorktree = collectLiveAgentsByWorktree(workspace, worktrees)

    expect(runtime.workContext?.worktreePath).toBe(MAIN_CHECKOUT)
    expect(liveByWorktree.get(LINKED_WORKTREE)?.map(agent => agent.sessionId))
      .toEqual([SESSION_ID])
    expect(liveByWorktree.get(MAIN_CHECKOUT) ?? []).toEqual([])
  })

  it('does not call a session LIVE when this renderer has no runtime for it (#880)', () => {
    // `runtime?.sessionStatus === 'running' || runtime?.streamPhase !== 'idle'`
    // was true for a MISSING runtime, because `undefined !== 'idle'` is. The
    // row still lists the session — "an agent is in here" is what the panel is
    // for — but `live` buckets it into the panel's live section, away from the
    // categories its own copy calls "Safe to delete".
    const worktrees = [
      status(MAIN_CHECKOUT, 'fixture/branch-1', 'main'),
      status(LINKED_WORKTREE, 'fixture/worktree-branch', 'active-unmerged'),
    ]
    const state = {
      tabs: [{ id: 'tab', title: 'Project' }],
      activeTabId: 'tab', stage: oneLaneStage('unobserved'),
      sessions: { unobserved: { cwd: LINKED_WORKTREE, kind: 'terminal', projectId: 'tab', joinedAt: 0 } },
      pinnedSessionIds: [],
    } as WorkspaceState
    // No entry at all for `unobserved`: the state this renderer is in before a
    // runtime exists, which is what #880 is about.
    const workspace = { state, runtimes: {} } as unknown as Workspace

    expect(collectLiveAgentsByWorktree(workspace, worktrees).get(LINKED_WORKTREE)).toEqual([
      expect.objectContaining({ sessionId: 'unobserved', live: false }),
    ])
  })

  it('lists a shell working inside a worktree (#865)', () => {
    // A shell has no transcript, so it has no workActivity; its cwd is the
    // only evidence and is exact for where it was started.
    const worktrees = [
      status(MAIN_CHECKOUT, 'fixture/branch-1', 'main'),
      status(LINKED_WORKTREE, 'fixture/worktree-branch', 'active-unmerged'),
    ]
    const state = {
      tabs: [{ id: 'tab', title: 'Project' }],
      activeTabId: 'tab', stage: oneLaneStage('shell'),
      sessions: { shell: { cwd: LINKED_WORKTREE, kind: 'terminal', projectId: 'tab', joinedAt: 0 } },
        pinnedSessionIds: [],
    } as WorkspaceState
    const workspace = {
      state,
      runtimes: { shell: { sessionStatus: 'running', streamPhase: 'idle' } as unknown as SessionRuntime },
    } as unknown as Workspace

    expect(collectLiveAgentsByWorktree(workspace, worktrees).get(LINKED_WORKTREE)).toEqual([
      expect.objectContaining({ sessionId: 'shell', kind: 'terminal', live: true }),
    ])
  })
})
