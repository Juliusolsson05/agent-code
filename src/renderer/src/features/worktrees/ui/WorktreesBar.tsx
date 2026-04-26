import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { WorktreeActivityIndexStatus, WorktreeActivitySummary } from '@preload/index'
import type { GitWorktreeStatus, WorktreeIdentity } from '@shared/types/git'
import { matchWorktree } from '@shared/work-context/matching'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import type { SessionId, Tab } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'

type Props = {
  cwd: string | null
  workspace: Workspace
  onClose: () => void
}

type LiveAgent = {
  sessionId: SessionId
  kind: 'claude' | 'codex'
  tabTitle: string
  live: boolean
  focused: boolean
}

type Row = GitWorktreeStatus & {
  activity: WorktreeActivitySummary | null
  liveAgents: LiveAgent[]
}

const POLL_MS = 10_000

export function WorktreesBar({ cwd, workspace, onClose }: Props) {
  const [worktrees, setWorktrees] = useState<GitWorktreeStatus[]>([])
  const [activity, setActivity] = useState<WorktreeActivitySummary[]>([])
  const [indexStatus, setIndexStatus] = useState<WorktreeActivityIndexStatus | null>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async (forceActivityRefresh = false) => {
    if (!cwd) {
      setWorktrees([])
      setActivity([])
      setIndexStatus(null)
      setError(false)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const [gitResult, activityResult] = await Promise.all([
        window.api.gitWorktreeStatus(cwd),
        window.api.worktreeActivitySummary(cwd, forceActivityRefresh),
      ])
      if (!gitResult.ok) {
        setWorktrees([])
        setActivity([])
        setIndexStatus(null)
        setError(true)
        return
      }
      setWorktrees(gitResult.worktrees)
      setError(false)
      if (activityResult.ok) {
        setActivity(activityResult.summaries)
        setIndexStatus(activityResult.status)
      }
    } catch {
      setWorktrees([])
      setActivity([])
      setIndexStatus(null)
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [cwd])

  useEffect(() => {
    void refresh(false)
    timerRef.current = setInterval(() => void refresh(false), POLL_MS)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [refresh])

  const liveByWorktree = useMemo(() => {
    const identities: WorktreeIdentity[] = worktrees.map(w => ({
      path: w.path,
      branch: w.branch,
      head: w.head,
      detached: w.detached,
    }))
    const byPath = new Map<string, LiveAgent[]>()
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
  }, [workspace.runtimes, workspace.state.sessions, workspace.state.tabs, worktrees])

  const rows = useMemo<Row[]>(() => {
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
  }, [activity, liveByWorktree, worktrees])

  return (
    <div className="h-full w-[340px] flex-shrink-0 border-l border-border bg-surface flex flex-col overflow-hidden text-[11px] font-code">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border text-[10px] text-muted uppercase tracking-wider select-none flex-shrink-0">
        <span>worktrees</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void refresh(true)}
            className="text-muted hover:text-ink"
            title="Refresh worktree activity index"
          >
            refresh
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-muted hover:text-ink text-[14px] leading-none"
          >
            ×
          </button>
        </div>
      </div>

      {error && (
        <div className="px-3 py-4 text-muted text-center">
          not a git repository
        </div>
      )}

      {!error && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="px-3 py-2 border-b border-border text-muted">
            {rows.length} worktrees
            {loading ? ' · loading' : ''}
            {indexStatus?.refreshing ? ' · indexing' : ''}
          </div>
          {rows.map(row => (
            <WorktreeRow key={row.path} row={row} />
          ))}
        </div>
      )}
    </div>
  )
}

function WorktreeRow({ row }: { row: Row }) {
  const liveAgent = row.liveAgents.find(agent => agent.live)
  const category = liveAgent ? 'live' : row.category
  return (
    <div className="px-3 py-2 border-b border-border hover:bg-surface-hi">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full flex-shrink-0 ${dotClass(category)}`} />
        <span className="flex-1 min-w-0 truncate text-ink" title={row.branch ?? row.path}>
          {row.branch ?? '(detached)'}
        </span>
        <span className="text-[9px] uppercase tracking-wider text-muted">
          {labelFor(category)}
        </span>
      </div>
      <div className="mt-1 truncate text-muted" title={row.path}>
        {shortenPath(row.path)}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[10px] text-muted">
        {row.dirty && <span className="text-amber-300">dirty</span>}
        {row.ahead !== null && row.behind !== null && (
          <span>
            +{row.ahead} / -{row.behind}
          </span>
        )}
        {row.lastCommitRelative && <span>{row.lastCommitRelative}</span>}
      </div>
      <div className="mt-1 text-[10px] text-muted">
        {liveAgent
          ? `${providerLabel(liveAgent.kind)} active · ${liveAgent.tabTitle}`
          : row.activity
            ? `${providerLabel(row.activity.lastProvider)} last touched ${relativeTime(row.activity.lastActivityAt)}`
            : 'no indexed agent activity'}
      </div>
    </div>
  )
}

function rankCategory(category: GitWorktreeStatus['category']): number {
  if (category === 'dirty') return 1
  if (category === 'active-unmerged') return 2
  if (category === 'review') return 3
  if (category === 'detached') return 4
  if (category === 'cleanup-merged') return 5
  return 6
}

function labelFor(category: string): string {
  if (category === 'live') return 'Live'
  if (category === 'dirty') return 'Dirty'
  if (category === 'active-unmerged') return 'Active'
  if (category === 'cleanup-merged') return 'Cleanup'
  if (category === 'detached') return 'Detached'
  if (category === 'main') return 'Main'
  return 'Review'
}

function dotClass(category: string): string {
  if (category === 'live') return 'bg-accent'
  if (category === 'dirty') return 'bg-amber-300'
  if (category === 'active-unmerged') return 'bg-sky-400'
  if (category === 'cleanup-merged') return 'bg-muted'
  if (category === 'detached') return 'bg-red-400'
  return 'bg-ink-dim'
}

function providerLabel(kind: 'claude' | 'codex'): string {
  return kind === 'codex' ? 'Codex' : 'Claude'
}

function shortenPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  if (parts.length <= 3) return path
  return `…/${parts.slice(-3).join('/')}`
}

function relativeTime(ts: number): string {
  const diffMs = Date.now() - ts
  if (diffMs < 0) return 'in the future'
  const secs = Math.floor(diffMs / 1000)
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  const years = Math.floor(days / 365)
  return `${years}y ago`
}
