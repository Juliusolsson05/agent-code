import { useCallback, useEffect, useRef, useState } from 'react'

import { formatWorktreeDump, labelFor, providerLabel } from '@renderer/features/worktrees/lib/formatWorktreeDump'
import { relativeTime } from '@renderer/lib/relativeTime'
import {
  loadWorktreeDump,
  type WorktreeDump,
  type WorktreeDumpRow,
} from '@renderer/features/worktrees/lib/loadWorktreeDump'
import type { Workspace } from '@renderer/workspace/workspaceStore'

type Props = {
  cwd: string | null
  workspace: Workspace
  onClose: () => void
}

const POLL_MS = 10_000

export function WorktreesBar({ cwd, workspace, onClose }: Props) {
  const [dump, setDump] = useState<WorktreeDump | null>(null)
  const [loading, setLoading] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async (forceActivityRefresh = false) => {
    setLoading(true)
    try {
      setDump(await loadWorktreeDump({ cwd, workspace, forceActivityRefresh }))
    } catch {
      setDump({
        cwd,
        generatedAt: Date.now(),
        rows: [],
        indexStatus: null,
        gitUnavailable: Boolean(cwd),
        activityUnavailable: true,
      })
    } finally {
      setLoading(false)
    }
  }, [cwd, workspace])

  const copyDump = useCallback(async () => {
    const currentDump = dump ?? {
      cwd,
      generatedAt: Date.now(),
      rows: [],
      indexStatus: null,
      gitUnavailable: false,
      activityUnavailable: true,
    }
    try {
      await navigator.clipboard.writeText(formatWorktreeDump(currentDump))
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
    if (copyResetRef.current) clearTimeout(copyResetRef.current)
    copyResetRef.current = setTimeout(() => setCopyState('idle'), 1600)
  }, [cwd, dump])

  useEffect(() => {
    void refresh(false)
    timerRef.current = setInterval(() => void refresh(false), POLL_MS)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      if (copyResetRef.current) clearTimeout(copyResetRef.current)
    }
  }, [refresh])

  const rows = dump?.rows ?? []
  const error = Boolean(dump?.gitUnavailable)
  const indexStatus = dump?.indexStatus ?? null

  return (
    <div className="h-full w-[340px] flex-shrink-0 border-l border-border bg-surface flex flex-col overflow-hidden text-[11px] font-code">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border text-[10px] text-muted uppercase tracking-wider select-none flex-shrink-0">
        <span>worktrees</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void copyDump()}
            className="text-muted hover:text-ink"
            title="Copy worktree status dump"
          >
            {copyState === 'idle' ? 'copy' : copyState}
          </button>
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

function WorktreeRow({ row }: { row: WorktreeDumpRow }) {
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
        {row.patchUniqueAhead !== null && row.patchUniqueAhead !== row.ahead && (
          <span>{row.patchUniqueAhead} patch-unique</span>
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

function dotClass(category: string): string {
  if (category === 'live') return 'bg-accent'
  if (category === 'dirty') return 'bg-amber-300'
  if (category === 'active-unmerged') return 'bg-sky-400'
  if (category === 'stale-review') return 'bg-violet-300'
  if (category === 'patch-equivalent') return 'bg-muted'
  if (category === 'cleanup-merged') return 'bg-muted'
  if (category === 'detached') return 'bg-red-400'
  return 'bg-ink-dim'
}

function shortenPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  if (parts.length <= 3) return path
  return `…/${parts.slice(-3).join('/')}`
}

