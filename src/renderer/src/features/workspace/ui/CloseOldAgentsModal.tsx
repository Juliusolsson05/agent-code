import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { relativeTime } from '@renderer/lib/relativeTime'
import { cwdBasename, providerGlyph } from '@renderer/features/workspace/lib/sessionDisplay'
import { resolveTabSessions } from '@renderer/workspace/queries'
import type { SessionId, Tab } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { Entry } from '@shared/types/transcript'

type Props = {
  open: boolean
  workspace: Workspace
  onClose: () => void
}

type ThresholdUnit = 'minutes' | 'hours' | 'days'
type ScopeMode = 'all' | 'selected'

type AgentRow = {
  sessionId: SessionId
  tabId: string
  tabTitle: string
  tabIndex: number
  kind: 'claude' | 'codex'
  cwd: string
  cwdBase: string
  isLive: boolean
  lastActiveAt: number | null
  ageMs: number | null
}

type ProjectRow = {
  cwd: string
  cwdBase: string
  total: number
  matching: number
}

const DEFAULT_THRESHOLD_VALUE = 4
const DEFAULT_THRESHOLD_UNIT: ThresholdUnit = 'hours'

function unitToMs(unit: ThresholdUnit): number {
  if (unit === 'minutes') return 60 * 1000
  if (unit === 'hours') return 60 * 60 * 1000
  return 24 * 60 * 60 * 1000
}

function absoluteTime(ts: number): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// Same activity source as AgentActivityModal: transcript timestamps are the
// only durable provider-agnostic signal the renderer already has for both
// Claude and Codex. Main tracks PTY activity too, but the workspace command
// needs to preview and filter before it asks main to kill anything; keeping the
// derivation local makes the modal deterministic from the state it displays.
function extractLatestEntryTs(entries: Entry[]): number | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const raw = (entries[i] as { timestamp?: unknown }).timestamp
    if (typeof raw !== 'string') continue
    const parsed = Date.parse(raw)
    if (!Number.isNaN(parsed)) return parsed
  }
  return null
}

function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours > 0 ? `${days}d ${restHours}h` : `${days}d`
}

export function CloseOldAgentsModal({ open, workspace, onClose }: Props) {
  const [thresholdValue, setThresholdValue] = useState(String(DEFAULT_THRESHOLD_VALUE))
  const [thresholdUnit, setThresholdUnit] = useState<ThresholdUnit>(DEFAULT_THRESHOLD_UNIT)
  const [scopeMode, setScopeMode] = useState<ScopeMode>('all')
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(() => new Set())
  const [includeLive, setIncludeLive] = useState(false)
  const [projectFilter, setProjectFilter] = useState('')
  const [closing, setClosing] = useState(false)
  const [nowTick, setNowTick] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setThresholdValue(String(DEFAULT_THRESHOLD_VALUE))
    setThresholdUnit(DEFAULT_THRESHOLD_UNIT)
    setScopeMode('all')
    setSelectedProjects(new Set())
    setIncludeLive(false)
    setProjectFilter('')
    setClosing(false)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  // Recompute ages while the modal is open so a borderline row ages into the
  // preview without the user changing a field. 10s matches AgentActivityModal:
  // precise enough for human decisions, cheap enough for large workspaces.
  useEffect(() => {
    if (!open) return
    const id = window.setInterval(() => setNowTick(t => t + 1), 10_000)
    return () => window.clearInterval(id)
  }, [open])

  const thresholdNumber = Number(thresholdValue)
  const thresholdMs =
    Number.isFinite(thresholdNumber) && thresholdNumber > 0
      ? thresholdNumber * unitToMs(thresholdUnit)
      : null

  const agentRows = useMemo<AgentRow[]>(() => {
    void nowTick
    const now = Date.now()
    const rows: AgentRow[] = []
    const seen = new Set<SessionId>()

    workspace.state.tabs.forEach((tab: Tab, tabIndex: number) => {
      for (const sessionId of resolveTabSessions(workspace.state, tab.id)) {
        if (seen.has(sessionId)) continue
        seen.add(sessionId)

        const meta = workspace.state.sessions[sessionId]
        if (!meta) continue
        const kind = meta.kind ?? 'claude'
        if (kind !== 'claude' && kind !== 'codex') continue

        const runtime = workspace.runtimes[sessionId]
        const running = runtime?.sessionStatus === 'running'
        const streaming = runtime?.streamPhase != null && runtime.streamPhase !== 'idle'
        const isLive = Boolean(running || streaming)
        const lastActiveAt = runtime
          ? extractLatestEntryTs(runtime.entries) ?? runtime.turnStartedAt ?? null
          : null

        rows.push({
          sessionId,
          tabId: tab.id,
          tabTitle: tab.title,
          tabIndex,
          kind,
          cwd: meta.cwd,
          cwdBase: cwdBasename(meta.cwd),
          isLive,
          lastActiveAt,
          ageMs: lastActiveAt == null ? null : Math.max(0, now - lastActiveAt),
        })
      }
    })

    rows.sort((a, b) => {
      const at = a.ageMs ?? -1
      const bt = b.ageMs ?? -1
      if (at !== bt) return bt - at
      if (a.cwdBase !== b.cwdBase) return a.cwdBase.localeCompare(b.cwdBase)
      return a.tabIndex - b.tabIndex
    })
    return rows
  }, [workspace.runtimes, workspace.state, nowTick])

  const selectedProjectSet = useMemo(
    () => selectedProjects,
    [selectedProjects],
  )

  const eligibleRows = useMemo(() => {
    if (thresholdMs == null) return []
    return agentRows.filter(row => {
      if (row.ageMs == null || row.ageMs < thresholdMs) return false
      if (!includeLive && row.isLive) return false
      return true
    })
  }, [agentRows, includeLive, thresholdMs])

  const matchingRows = useMemo(() => {
    if (scopeMode === 'all') return eligibleRows
    return eligibleRows.filter(row => selectedProjectSet.has(row.cwd))
  }, [eligibleRows, scopeMode, selectedProjectSet])

  const projects = useMemo<ProjectRow[]>(() => {
    const matchingByProject = new Map<string, number>()
    for (const row of eligibleRows) {
      matchingByProject.set(row.cwd, (matchingByProject.get(row.cwd) ?? 0) + 1)
    }

    const byProject = new Map<string, ProjectRow>()
    for (const row of agentRows) {
      const existing = byProject.get(row.cwd)
      if (existing) {
        existing.total += 1
      } else {
        byProject.set(row.cwd, {
          cwd: row.cwd,
          cwdBase: row.cwdBase,
          total: 1,
          matching: 0,
        })
      }
    }

    for (const project of byProject.values()) {
      project.matching = matchingByProject.get(project.cwd) ?? 0
    }

    return Array.from(byProject.values()).sort((a, b) => {
      if (a.matching !== b.matching) return b.matching - a.matching
      return a.cwdBase.localeCompare(b.cwdBase)
    })
  }, [agentRows, eligibleRows])

  const filteredProjects = useMemo(() => {
    const query = projectFilter.trim().toLowerCase()
    if (!query) return projects
    return projects.filter(project =>
      project.cwd.toLowerCase().includes(query) ||
      project.cwdBase.toLowerCase().includes(query),
    )
  }, [projectFilter, projects])

  const liveMatchCount = matchingRows.filter(row => row.isLive).length
  const selectedCount = selectedProjects.size
  const thresholdValid = thresholdMs != null

  const toggleProject = useCallback((cwd: string) => {
    setSelectedProjects(prev => {
      const next = new Set(prev)
      if (next.has(cwd)) next.delete(cwd)
      else next.add(cwd)
      return next
    })
  }, [])

  const selectAllProjects = useCallback(() => {
    setSelectedProjects(new Set(projects.map(project => project.cwd)))
  }, [projects])

  const clearProjects = useCallback(() => {
    setSelectedProjects(new Set())
  }, [])

  const closeMatchingAgents = useCallback(async () => {
    if (matchingRows.length === 0 || closing) return
    setClosing(true)
    try {
      // Sequential close is intentional. workspace.closeSession mutates the
      // tile tree, detached-session map, undo stack, runtime maps, and linked
      // children. Firing N closes concurrently would make each call read a
      // slightly stale snapshot and could drop layout/undo bookkeeping. Batch
      // cleanup is rare enough that predictable mutation beats raw speed.
      for (const row of matchingRows) {
        await workspace.closeSession(row.sessionId)
      }
      onClose()
    } finally {
      setClosing(false)
    }
  }, [closing, matchingRows, onClose, workspace])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    },
    [onClose],
  )

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Close Old Agents"
      className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/30"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose()
      }}
      onKeyDown={onKeyDown}
    >
      <div className="w-[min(860px,94vw)] max-h-[86vh] overflow-hidden bg-surface border border-border-hi flex flex-col">
        <div className="flex-shrink-0 border-b border-border px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[13px] text-ink">Close Old Agents</div>
              <div className="mt-1 text-[11px] text-muted">
                Close Claude and Codex agents that have been inactive past the threshold.
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="px-2 py-1 text-[10px] border border-border text-ink-dim hover:text-ink hover:border-border-hi"
            >
              Esc
            </button>
          </div>

          <div className="mt-4 grid grid-cols-[minmax(220px,1fr)_minmax(220px,1fr)] gap-3">
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-muted">
                Inactive for more than
              </label>
              <div className="mt-1 flex items-center gap-2">
                <input
                  ref={inputRef}
                  type="number"
                  min="1"
                  step="1"
                  value={thresholdValue}
                  onChange={e => setThresholdValue(e.target.value)}
                  className="w-24 px-2 py-1.5 bg-canvas border border-border text-[12px] text-ink outline-none focus:border-accent"
                />
                <select
                  value={thresholdUnit}
                  onChange={e => setThresholdUnit(e.target.value as ThresholdUnit)}
                  className="px-2 py-1.5 bg-canvas border border-border text-[12px] text-ink outline-none focus:border-accent"
                >
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                  <option value="days">days</option>
                </select>
              </div>
              {!thresholdValid && (
                <div className="mt-1 text-[10px] text-red-300">
                  Enter a number greater than zero.
                </div>
              )}
            </div>

            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted">
                Project scope
              </div>
              <div className="mt-1 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setScopeMode('all')}
                  className={`px-2.5 py-1.5 text-[11px] border ${
                    scopeMode === 'all'
                      ? 'border-accent text-accent bg-accent/10'
                      : 'border-border text-ink-dim hover:text-ink hover:border-border-hi'
                  }`}
                >
                  All projects
                </button>
                <button
                  type="button"
                  onClick={() => setScopeMode('selected')}
                  className={`px-2.5 py-1.5 text-[11px] border ${
                    scopeMode === 'selected'
                      ? 'border-accent text-accent bg-accent/10'
                      : 'border-border text-ink-dim hover:text-ink hover:border-border-hi'
                  }`}
                >
                  Selected projects
                </button>
              </div>
              <label className="mt-3 flex items-center gap-2 text-[11px] text-ink-dim">
                <input
                  type="checkbox"
                  checked={includeLive}
                  onChange={e => setIncludeLive(e.target.checked)}
                  className="accent-current"
                />
                Include agents that are currently running
              </label>
            </div>
          </div>
        </div>

        <div className="flex-1 min-h-0 grid grid-cols-[280px_minmax(0,1fr)]">
          <div className="min-h-0 border-r border-border flex flex-col">
            <div className="flex-shrink-0 px-3 py-2 border-b border-border">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] text-ink">Projects</div>
                {scopeMode === 'selected' && (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={selectAllProjects}
                      className="px-1.5 py-0.5 text-[10px] text-ink-dim hover:text-ink"
                    >
                      all
                    </button>
                    <button
                      type="button"
                      onClick={clearProjects}
                      className="px-1.5 py-0.5 text-[10px] text-ink-dim hover:text-ink"
                    >
                      clear
                    </button>
                  </div>
                )}
              </div>
              {scopeMode === 'selected' && projects.length > 8 && (
                <input
                  type="text"
                  value={projectFilter}
                  onChange={e => setProjectFilter(e.target.value)}
                  placeholder="Filter projects"
                  className="mt-2 w-full px-2 py-1 bg-canvas border border-border text-[11px] text-ink outline-none focus:border-accent"
                />
              )}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              {projects.length === 0 ? (
                <div className="px-3 py-6 text-center text-[11px] text-muted">
                  No open agents.
                </div>
              ) : (
                filteredProjects.map(project => {
                  const selected = selectedProjects.has(project.cwd)
                  const disabled = scopeMode === 'all'
                  return (
                    <label
                      key={project.cwd}
                      className={`
                        flex items-start gap-2 px-3 py-2 border-b border-border last:border-b-0
                        ${disabled ? 'text-ink-dim' : 'cursor-pointer hover:bg-surface-hi'}
                      `}
                    >
                      <input
                        type="checkbox"
                        disabled={disabled}
                        checked={scopeMode === 'all' || selected}
                        onChange={() => toggleProject(project.cwd)}
                        className="mt-0.5 accent-current disabled:opacity-50"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[11px] text-ink truncate">
                          {project.cwdBase}
                        </span>
                        <span className="block text-[10px] text-muted truncate">
                          {project.cwd}
                        </span>
                      </span>
                      <span className="flex-shrink-0 text-[10px] text-muted tabular-nums">
                        {project.matching}/{project.total}
                      </span>
                    </label>
                  )
                })
              )}
            </div>
          </div>

          <div className="min-h-0 flex flex-col">
            <div className="flex-shrink-0 px-4 py-2 border-b border-border flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] text-ink">Preview</div>
                <div className="mt-0.5 text-[10px] text-muted">
                  {matchingRows.length === 0
                    ? 'No agents match the current filters.'
                    : `${matchingRows.length} agent${matchingRows.length === 1 ? '' : 's'} will be closed${liveMatchCount > 0 ? `, including ${liveMatchCount} running` : ''}.`}
                </div>
              </div>
              {scopeMode === 'selected' && (
                <div className="text-[10px] text-muted">
                  {selectedCount} selected
                </div>
              )}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto">
              {matchingRows.length === 0 ? (
                <div className="px-4 py-10 text-center text-[12px] text-muted">
                  {thresholdValid
                    ? `No agents have been inactive for more than ${thresholdValue || '0'} ${thresholdUnit}.`
                    : 'Enter a valid threshold to preview matching agents.'}
                </div>
              ) : (
                matchingRows.map(row => (
                  <div
                    key={row.sessionId}
                    className="flex items-start gap-3 px-4 py-2.5 border-b border-border last:border-b-0"
                  >
                    <div className="flex-shrink-0 w-[72px] flex items-center gap-2">
                      <span className={row.isLive ? 'text-red-300' : 'text-muted'}>
                        {providerGlyph(row.kind)}
                      </span>
                      <span className="text-[11px] uppercase tracking-wider text-muted">
                        {row.kind}
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] text-ink truncate">
                        {row.cwdBase}
                      </div>
                      <div className="mt-0.5 text-[10px] text-muted truncate">
                        tab {row.tabIndex + 1} · {row.tabTitle} · {row.cwd}
                      </div>
                    </div>
                    <div className="flex-shrink-0 w-[150px] text-right">
                      {row.isLive ? (
                        <div className="text-[11px] text-red-300">running</div>
                      ) : null}
                      {row.lastActiveAt != null && row.ageMs != null ? (
                        <>
                          <div className="text-[11px] text-ink-dim">
                            inactive {formatDuration(row.ageMs)}
                          </div>
                          <div className="text-[10px] text-muted">
                            {relativeTime(row.lastActiveAt)} · {absoluteTime(row.lastActiveAt)}
                          </div>
                        </>
                      ) : (
                        <div className="text-[10px] text-muted">unknown activity</div>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="flex-shrink-0 border-t border-border px-4 py-3 flex items-center justify-between gap-3">
          <div className="text-[10px] text-muted">
            Running agents are excluded unless explicitly included. Terminals are never included.
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={closing}
              className="px-3 py-1.5 text-[11px] border border-border text-ink-dim hover:text-ink hover:border-border-hi disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void closeMatchingAgents()}
              disabled={closing || matchingRows.length === 0 || !thresholdValid}
              className={`
                px-3 py-1.5 text-[11px] border
                ${matchingRows.length > 0 && thresholdValid
                  ? 'border-red-500/60 bg-red-500/10 text-red-200 hover:bg-red-500/20'
                  : 'border-border text-muted opacity-60 cursor-not-allowed'}
              `}
            >
              {closing
                ? 'Closing…'
                : liveMatchCount > 0
                  ? `Close ${matchingRows.length} Agents, Including ${liveMatchCount} Running`
                  : `Close ${matchingRows.length} Agent${matchingRows.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
