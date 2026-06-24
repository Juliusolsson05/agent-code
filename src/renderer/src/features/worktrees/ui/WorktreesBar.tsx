import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { formatWorktreeDump, labelFor, providerLabel } from '@renderer/features/worktrees/lib/formatWorktreeDump'
import { relativeTime } from '@renderer/lib/relativeTime'
import {
  loadWorktreeDump,
  type WorktreeDump,
  type WorktreeDumpRow,
} from '@renderer/features/worktrees/lib/loadWorktreeDump'
import { worktreeColorForIdentity } from '@renderer/workspace/tile-tree/TileLeaf/worktreeBadgeColor'
import type { Workspace } from '@renderer/workspace/workspaceStore'

type Props = {
  cwd: string | null
  workspace: Workspace
  onClose: () => void
}

const POLL_MS = 10_000

// WHY skip the mount refresh when a dump for the same cwd is fresh:
// opening the panel re-mounts this component, and an unconditional
// refresh(false) re-runs the git worktree scan every time the panel is
// toggled. That scan is cheap-ish but not free, and toggling the panel
// rapidly used to fan out redundant work. If we already have a dump for
// this exact cwd from the last few seconds, reuse it on mount and let
// the 10s poll take over. forceActivityRefresh stays false here — only
// the explicit refresh button forces the (expensive) activity reindex.
const MOUNT_REUSE_WINDOW_MS = 5_000

// Section grouping for the panel. We render rows under headed sections
// ordered by rankCategory so the most actionable worktrees (live, dirty)
// float to the top and the safe-to-delete cleanup buckets sink to the
// bottom. This is presentation only — loadWorktreeDump already sorts the
// flat list; we just bucket that order into labeled groups.
type SectionKey =
  | 'live'
  | 'dirty'
  | 'active-review'
  | 'cleanup'
  | 'detached'

const SECTION_ORDER: SectionKey[] = [
  'live',
  'dirty',
  'active-review',
  'detached',
  'cleanup',
]

const SECTION_LABEL: Record<SectionKey, string> = {
  live: 'Live',
  dirty: 'Dirty',
  'active-review': 'Active / Review',
  cleanup: 'Cleanup',
  detached: 'Detached',
}

// Map a row's effective category to its panel section. "live" is decided
// by an actually-running agent, not by git category, so it is computed by
// the caller and passed in. Everything else folds the finer git
// categories into the five coarse human-facing buckets.
function sectionForCategory(category: string): SectionKey {
  if (category === 'live') return 'live'
  if (category === 'dirty') return 'dirty'
  if (category === 'detached') return 'detached'
  if (category === 'patch-equivalent' || category === 'cleanup-merged') {
    return 'cleanup'
  }
  // active-unmerged, stale-review, review, main, and anything unknown
  // all read as "has unmerged work, look before you leap".
  return 'active-review'
}

// Short tooltips that draw the one distinction that actually matters when
// triaging worktrees: is there unmerged work I might lose (review) versus
// is this already integrated and safe to delete (cleanup)? Without this,
// "stale-review" and "patch-equivalent" look equally disposable in the
// UI, and that ambiguity is exactly how unmerged work gets deleted.
function categoryExplanation(category: string): string {
  switch (category) {
    case 'live':
      return 'An agent is actively running in this worktree right now.'
    case 'dirty':
      return 'Uncommitted changes are present — commit or stash before removing.'
    case 'active-unmerged':
      return 'Has commits not yet merged to main. Active work; do not delete.'
    case 'stale-review':
      return 'Unmerged commits, but no recent activity. Review before removing — work may be lost.'
    case 'review':
      return 'Unmerged work that needs review before it can be safely removed.'
    case 'patch-equivalent':
      return 'Commits are patch-equivalent to main (already applied). Safe to delete.'
    case 'cleanup-merged':
      return 'Fully merged into main. Safe to delete.'
    case 'detached':
      return 'Detached HEAD — no branch. Inspect before removing.'
    case 'main':
      return 'The primary worktree.'
    default:
      return 'Unmerged work that needs review before removal.'
  }
}

export function WorktreesBar({ cwd, workspace, onClose }: Props) {
  const [dump, setDump] = useState<WorktreeDump | null>(null)
  const [loading, setLoading] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace
  const refreshInFlightRef = useRef<Promise<void> | null>(null)

  const refresh = useCallback((forceActivityRefresh = false) => {
    if (refreshInFlightRef.current) return refreshInFlightRef.current
    const run = (async () => {
      setLoading(true)
      try {
        setDump(await loadWorktreeDump({
          cwd,
          workspace: workspaceRef.current,
          forceActivityRefresh,
        }))
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
    })().finally(() => {
      if (refreshInFlightRef.current === run) refreshInFlightRef.current = null
    })
    refreshInFlightRef.current = run
    return run
  }, [cwd])

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

  // We read the latest dump through a ref inside the mount effect so the
  // effect can decide whether to reuse a fresh dump WITHOUT taking `dump`
  // as a dependency (which would re-run the effect — and restart the
  // poll timer — on every dump change). The effect should fire only when
  // cwd changes; the latest workspace snapshot is read through workspaceRef so
  // agent runtime churn does not restart git/worktree scans.
  const dumpRef = useRef(dump)
  dumpRef.current = dump

  useEffect(() => {
    const existing = dumpRef.current
    const fresh =
      existing &&
      existing.cwd === cwd &&
      Date.now() - existing.generatedAt < MOUNT_REUSE_WINDOW_MS
    if (!fresh) void refresh(false)
    timerRef.current = setInterval(() => void refresh(false), POLL_MS)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      if (copyResetRef.current) clearTimeout(copyResetRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally
  // keyed on `refresh` (which already closes over cwd+workspace); `dump`
  // is read via ref to avoid restarting the poll on every dump update.
  }, [refresh])

  const rows = dump?.rows ?? []
  const error = Boolean(dump?.gitUnavailable)
  const indexStatus = dump?.indexStatus ?? null

  // Bucket the already-sorted flat rows into headed sections. We keep the
  // upstream sort order within each section by iterating rows in place;
  // sections themselves render in SECTION_ORDER. "live" is per-row decided
  // by an actually-running agent, mirroring WorktreeRow's own logic.
  const sections = useMemo(() => {
    const grouped = new Map<SectionKey, WorktreeDumpRow[]>()
    for (const row of rows) {
      const live = row.liveAgents.some(agent => agent.live)
      const effectiveCategory = live ? 'live' : row.category
      const key = sectionForCategory(effectiveCategory)
      const bucket = grouped.get(key) ?? []
      bucket.push(row)
      grouped.set(key, bucket)
    }
    return SECTION_ORDER
      .map(key => ({ key, rows: grouped.get(key) ?? [] }))
      .filter(section => section.rows.length > 0)
  }, [rows])

  return (
    <div className="h-full w-[340px] flex-shrink-0 border-l border-border bg-surface flex flex-col overflow-hidden text-[11px] font-code">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border text-[10px] text-muted uppercase tracking-wider select-none flex-shrink-0">
        <span>worktrees</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void copyDump()}
            className={
              copyState === 'copied'
                ? 'text-accent'
                : copyState === 'failed'
                  ? 'text-red-400'
                  : 'text-muted hover:text-ink'
            }
            title={
              copyState === 'failed'
                ? 'Clipboard copy failed — try again'
                : 'Copy worktree status dump to clipboard'
            }
          >
            {copyState === 'idle'
              ? 'copy'
              : copyState === 'copied'
                ? 'copied ✓'
                : 'failed ✗'}
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
          {sections.map(section => (
            <div key={section.key}>
              <div className="px-3 py-1 bg-surface-hi border-b border-border text-[9px] uppercase tracking-wider text-muted flex items-center justify-between sticky top-0">
                <span>{SECTION_LABEL[section.key]}</span>
                <span className="text-ink-dim">{section.rows.length}</span>
              </div>
              {section.rows.map(row => (
                <WorktreeRow key={row.path} row={row} cwd={cwd} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function WorktreeRow({ row, cwd }: { row: WorktreeDumpRow; cwd: string | null }) {
  const liveAgent = row.liveAgents.find(agent => agent.live)
  const category = liveAgent ? 'live' : row.category

  // IDENTITY color (stable per branch, shared with the pane badge) drives
  // the left border. It answers "which worktree is this?" and must match
  // the badge in the grid so the two views reinforce the same color
  // memory. The category STATUS stays a separate text label/dot so we
  // don't overload one color channel with two unrelated meanings.
  const identityColor = worktreeColorForIdentity({
    repoRoot: cwd,
    branch: row.branch,
    worktreePath: row.path,
  })

  // Surface every open agent for this worktree (not just the first live
  // one) as a pill, distinguishing running from parked. Parking = open in
  // a tab but idle; running = actively streaming. Both consume the
  // worktree, so both are worth showing when deciding if it is safe to
  // touch.
  return (
    <div
      className="px-3 py-2 border-b border-border hover:bg-surface-hi border-l-2"
      style={{ borderLeftColor: identityColor ?? 'transparent' }}
    >
      <div className="flex items-center gap-2">
        <span
          className={`h-2 w-2 rounded-full flex-shrink-0 ${dotClass(category)}`}
          title={categoryExplanation(category)}
        />
        <span className="flex-1 min-w-0 truncate text-ink" title={row.branch ?? row.path}>
          {row.branch ?? '(detached)'}
        </span>
        <span
          className="text-[9px] uppercase tracking-wider text-muted cursor-help"
          title={categoryExplanation(category)}
        >
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
      {row.liveAgents.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {row.liveAgents.map(agent => (
            <span
              key={agent.sessionId}
              className={`px-1.5 py-[1px] text-[9px] rounded-sm border ${
                agent.live
                  ? 'border-accent text-accent'
                  : 'border-border text-muted'
              }`}
              title={`${providerLabel(agent.kind)} ${agent.live ? 'running' : 'parked'} in "${agent.tabTitle}"`}
            >
              {providerLabel(agent.kind)} · {agent.tabTitle}
              {agent.live ? '' : ' (parked)'}
            </span>
          ))}
        </div>
      )}
      {row.liveAgents.length === 0 && (
        <div className="mt-1 text-[10px] text-muted">
          {row.activity
            ? `${providerLabel(row.activity.lastProvider)} last touched ${relativeTime(row.activity.lastActivityAt)}`
            : 'no indexed agent activity'}
        </div>
      )}
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
