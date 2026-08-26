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
        root: { type: 'leaf', sessionId: SESSION_ID },
        focusedSessionId: SESSION_ID,
      }],
      activeTabId: 'tab-recorded',
      dispatchMode: null,
      sessions: {
        [SESSION_ID]: { cwd: MAIN_CHECKOUT, kind: 'codex' },
      },
      detachedSessions: {},
      buried: [],
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
})
