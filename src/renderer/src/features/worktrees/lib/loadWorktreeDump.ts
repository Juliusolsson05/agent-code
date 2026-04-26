import type { WorktreeActivityIndexStatus, WorktreeActivitySummary } from '@preload/index'
import type { GitWorktreeStatus, WorktreeIdentity } from '@shared/types/git'
import { matchWorktree } from '@shared/work-context/matching'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import type { SessionId, Tab } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'

export type WorktreeLiveAgent = {
  sessionId: SessionId
  kind: 'claude' | 'codex'
  tabTitle: string
  live: boolean
  focused: boolean
}

export type WorktreeDumpRow = GitWorktreeStatus & {
  activity: WorktreeActivitySummary | null
  liveAgents: WorktreeLiveAgent[]
}

export type WorktreeDump = {
  cwd: string | null
  generatedAt: number
  rows: WorktreeDumpRow[]
  indexStatus: WorktreeActivityIndexStatus | null
  gitUnavailable: boolean
  activityUnavailable: boolean
}

export async function loadWorktreeDump(params: {
  cwd: string | null
  workspace: Workspace
  forceActivityRefresh?: boolean
}): Promise<WorktreeDump> {
  const { cwd, workspace, forceActivityRefresh = false } = params
  if (!cwd) {
    return {
      cwd,
      generatedAt: Date.now(),
      rows: [],
      indexStatus: null,
      gitUnavailable: false,
      activityUnavailable: true,
    }
  }

  const gitResult = await window.api.gitWorktreeStatus(cwd)
    .catch(() => ({ ok: false as const, error: 'git unavailable' }))
  if (!gitResult.ok) {
    return {
      cwd,
      generatedAt: Date.now(),
      rows: [],
      indexStatus: null,
      gitUnavailable: true,
      activityUnavailable: true,
    }
  }

  const activityResult = await window.api.worktreeActivitySummary(cwd, forceActivityRefresh)
    .catch(() => ({ ok: false as const, error: 'activity unavailable' }))
  const activity = activityResult.ok ? activityResult.summaries : []
  const liveByWorktree = collectLiveAgentsByWorktree(workspace, gitResult.worktrees)
  const rows = mergeWorktreeRows(gitResult.worktrees, activity, liveByWorktree)

  return {
    cwd,
    generatedAt: Date.now(),
    rows,
    indexStatus: activityResult.ok ? activityResult.status : null,
    gitUnavailable: false,
    activityUnavailable: !activityResult.ok,
  }
}

export function mergeWorktreeRows(
  worktrees: GitWorktreeStatus[],
  activity: WorktreeActivitySummary[],
  liveByWorktree: Map<string, WorktreeLiveAgent[]>,
): WorktreeDumpRow[] {
  const activityByPath = new Map(activity.map(item => [item.worktreePath, item]))
  return worktrees.map(worktree => ({
    ...worktree,
    activity: activityByPath.get(worktree.path) ?? null,
    liveAgents: liveByWorktree.get(worktree.path) ?? [],
  })).sort((a, b) => {
    const aLive = a.liveAgents.some(agent => agent.live)
    const bLive = b.liveAgents.some(agent => agent.live)
    if (aLive !== bLive) return aLive ? -1 : 1
    const categoryRank = rankCategory(a.category) - rankCategory(b.category)
    if (categoryRank !== 0) return categoryRank
    return (b.activity?.lastActivityAt ?? b.lastCommitAt ?? 0) -
      (a.activity?.lastActivityAt ?? a.lastCommitAt ?? 0)
  })
}

export function collectLiveAgentsByWorktree(
  workspace: Workspace,
  worktrees: GitWorktreeStatus[],
): Map<string, WorktreeLiveAgent[]> {
  const identities: WorktreeIdentity[] = worktrees.map(w => ({
    path: w.path,
    branch: w.branch,
    head: w.head,
    detached: w.detached,
  }))
  const byPath = new Map<string, WorktreeLiveAgent[]>()
  workspace.state.tabs.forEach((tab: Tab) => {
    for (const sessionId of collectLeaves(tab.root)) {
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? 'claude'
      if (kind !== 'claude' && kind !== 'codex') continue
      const runtime = workspace.runtimes[sessionId]
      const contextPath = runtime?.workContext?.worktreePath ?? meta?.cwd
      const matched = matchWorktree(contextPath, identities)
      if (!matched) continue
      const rows = byPath.get(matched.path) ?? []
      rows.push({
        sessionId,
        kind,
        tabTitle: tab.title,
        live: Boolean(runtime?.sessionStatus === 'running' || runtime?.streamPhase !== 'idle'),
        focused: tab.focusedSessionId === sessionId,
      })
      byPath.set(matched.path, rows)
    }
  })
  return byPath
}

export function rankCategory(category: GitWorktreeStatus['category']): number {
  if (category === 'dirty') return 1
  if (category === 'active-unmerged') return 2
  if (category === 'review') return 3
  if (category === 'detached') return 4
  if (category === 'cleanup-merged') return 5
  return 6
}
