import { DEFAULT_PROVIDER, isAgentProviderKind, type AgentProviderKind } from '@shared/types/providerKind'
import type { WorktreeActivityIndexStatus, WorktreeActivitySummary } from '@preload/index'
import type { GitWorktreeStatus, WorktreeIdentity } from '@shared/types/git'
import { matchWorktree } from '@shared/work-context/matching'
import { resolveTabSessions } from '@renderer/workspace/queries'
import type { SessionId, Tab } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'

export type WorktreeLiveAgent = {
  sessionId: SessionId
  kind: AgentProviderKind
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
  /** Refines gitUnavailable the same way GitBar's error state does (#495
   *  A5, threaded here by the #508 review): true means the MACHINE has no
   *  usable git (missing binary, or macOS's no-CLT xcrun shim), false
   *  means git works but this cwd is not a git worktree. Only meaningful
   *  when gitUnavailable is true; the two need different copy because
   *  "not a git repository" is actively misleading on a git-less Mac. */
  gitMissing: boolean
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
      gitMissing: false,
      activityUnavailable: true,
    }
  }

  // The IPC-rejection fallback claims gitMissing:false, not true: a rejected
  // invoke means the BRIDGE failed (main crashed mid-call, channel torn
  // down), which says nothing about git on the machine — only main's own
  // classified { ok:false, gitMissing } result is allowed to make that claim.
  const gitResult = await window.api.gitWorktreeStatus(cwd)
    .catch(() => ({ ok: false as const, gitMissing: false }))
  if (!gitResult.ok) {
    return {
      cwd,
      generatedAt: Date.now(),
      rows: [],
      indexStatus: null,
      gitUnavailable: true,
      gitMissing: gitResult.gitMissing,
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
    gitMissing: false,
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
  // resolveTabSessions covers BOTH grid leaves and detached Dispatch
  // agents for the tab. The previous implementation walked grid only,
  // so a Claude/Codex agent running in a worktree but parked in
  // Dispatch was missing from this tab's row — even though it was
  // genuinely live and consuming the worktree. The "live agents per
  // worktree" view needs the union, not the visible-grid subset.
  workspace.state.tabs.forEach((tab: Tab) => {
    for (const sessionId of resolveTabSessions(workspace.state, tab.id)) {
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? DEFAULT_PROVIDER
      // Registry-driven: the worktree activity view lists live agents per
      // worktree regardless of provider — a running OpenCode session
      // consumes the worktree just as much as a Claude or Codex one. The
      // hardcoded pair here would silently hide OpenCode sessions from
      // per-worktree activity even though they're on-disk in the tab.
      if (!isAgentProviderKind(kind)) continue
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
  if (category === 'stale-review') return 3
  if (category === 'review') return 4
  if (category === 'detached') return 5
  if (category === 'patch-equivalent') return 6
  if (category === 'cleanup-merged') return 7
  return 8
}
