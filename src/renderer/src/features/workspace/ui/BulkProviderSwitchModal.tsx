import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { relativeTime } from '@renderer/lib/relativeTime'
import { cwdBasename, providerGlyph } from '@renderer/features/workspace/lib/sessionDisplay'
import { resolveTabSessions } from '@renderer/workspace/queries'
import type { SessionId, Tab } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { AgentProviderKind } from '@shared/types/providerKind'

// Switch Agents modal — bulk provider switch + remembered-batch return.
//
// Structurally a sibling of CloseOldAgentsModal (same two-pane scope/preview
// shape), but the operation is a reversible round-trip rather than a
// destructive cleanup:
//   - Top half: pick a DIRECTION and SCOPE, preview the affected agents, switch.
//   - Top banner (only when a batch is remembered): send the most recent batch
//     back to its origin provider. This is the ONLY return affordance — there
//     is no command-palette entry or keybind for it.
//
// Unlike Close Old Agents there is no time threshold and no "include running"
// toggle: the trigger for this feature is "I hit a usage limit, get everyone
// off this provider", so every source-kind agent is eligible. We still SHOW how
// many are mid-turn and will be interrupted, so the choice is informed.

type Props = {
  open: boolean
  workspace: Workspace
  onClose: () => void
}

type ScopeMode = 'all' | 'selected'

type AgentRow = {
  sessionId: SessionId
  tabId: string
  tabTitle: string
  tabIndex: number
  kind: AgentProviderKind
  cwd: string
  cwdBase: string
  isLive: boolean
}

type ProjectRow = {
  cwd: string
  cwdBase: string
  total: number
}

function providerLabel(kind: AgentProviderKind): string {
  return kind === 'codex' ? 'Codex' : 'Claude'
}

export function BulkProviderSwitchModal({ open, workspace, onClose }: Props) {
  // `target` is the provider agents move TO. Source is the other one — and the
  // preview enumerates only source-kind agents, since you can't switch a Claude
  // agent "to Claude". Default target Claude (source Codex) matches the most
  // common trigger the user described (Codex limited → move to Claude).
  const [target, setTarget] = useState<AgentProviderKind>('claude')
  const [scopeMode, setScopeMode] = useState<ScopeMode>('all')
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(() => new Set())
  const [projectFilter, setProjectFilter] = useState('')
  const [busy, setBusy] = useState(false)
  // Live status (mid-turn) can change while the modal sits open. Re-tick every
  // 10s so the ⚠ interrupt count stays honest, matching Close Old Agents.
  const [nowTick, setNowTick] = useState(0)

  const source: AgentProviderKind = target === 'claude' ? 'codex' : 'claude'

  useEffect(() => {
    if (!open) return
    setTarget('claude')
    setScopeMode('all')
    setSelectedProjects(new Set())
    setProjectFilter('')
    setBusy(false)
  }, [open])

  useEffect(() => {
    if (!open) return
    const id = window.setInterval(() => setNowTick(t => t + 1), 10_000)
    return () => window.clearInterval(id)
  }, [open])

  const batch = workspace.state.lastProviderSwitchBatch ?? null

  const agentRows = useMemo<AgentRow[]>(() => {
    void nowTick
    const rows: AgentRow[] = []
    const seen = new Set<SessionId>()

    workspace.state.tabs.forEach((tab: Tab, tabIndex: number) => {
      for (const sessionId of resolveTabSessions(workspace.state, tab.id)) {
        if (seen.has(sessionId)) continue
        seen.add(sessionId)

        const meta = workspace.state.sessions[sessionId]
        if (!meta) continue
        const kind = meta.kind ?? 'claude'
        // Only source-provider agents are switchable to the target. Terminals
        // (kind 'terminal') are excluded by this same check.
        if (kind !== source) continue

        const runtime = workspace.runtimes[sessionId]
        const running = runtime?.sessionStatus === 'running'
        const streaming = runtime?.streamPhase != null && runtime.streamPhase !== 'idle'

        rows.push({
          sessionId,
          tabId: tab.id,
          tabTitle: tab.title,
          tabIndex,
          kind,
          cwd: meta.cwd,
          cwdBase: cwdBasename(meta.cwd),
          isLive: Boolean(running || streaming),
        })
      }
    })

    rows.sort((a, b) => {
      if (a.cwdBase !== b.cwdBase) return a.cwdBase.localeCompare(b.cwdBase)
      return a.tabIndex - b.tabIndex
    })
    return rows
  }, [workspace.runtimes, workspace.state, source, nowTick])

  const matchingRows = useMemo(() => {
    if (scopeMode === 'all') return agentRows
    return agentRows.filter(row => selectedProjects.has(row.cwd))
  }, [agentRows, scopeMode, selectedProjects])

  const projects = useMemo<ProjectRow[]>(() => {
    const byProject = new Map<string, ProjectRow>()
    for (const row of agentRows) {
      const existing = byProject.get(row.cwd)
      if (existing) existing.total += 1
      else byProject.set(row.cwd, { cwd: row.cwd, cwdBase: row.cwdBase, total: 1 })
    }
    return Array.from(byProject.values()).sort((a, b) => {
      if (a.total !== b.total) return b.total - a.total
      return a.cwdBase.localeCompare(b.cwdBase)
    })
  }, [agentRows])

  const filteredProjects = useMemo(() => {
    const query = projectFilter.trim().toLowerCase()
    if (!query) return projects
    return projects.filter(
      project =>
        project.cwd.toLowerCase().includes(query) ||
        project.cwdBase.toLowerCase().includes(query),
    )
  }, [projectFilter, projects])

  const midTurnCount = matchingRows.filter(row => row.isLive).length
  const selectedCount = selectedProjects.size

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

  const runSwitch = useCallback(async () => {
    if (matchingRows.length === 0 || busy) return
    setBusy(true)
    try {
      await workspace.switchAgentsToProvider(
        matchingRows.map(row => row.sessionId),
        target,
      )
      onClose()
    } finally {
      setBusy(false)
    }
  }, [busy, matchingRows, onClose, target, workspace])

  const runReturn = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      // Intentionally NOT closing the modal: the banner clears itself when
      // workspace state updates, giving the user visible confirmation the batch
      // was returned without yanking the modal out from under them.
      await workspace.returnLastProviderSwitchBatch()
    } finally {
      setBusy(false)
    }
  }, [busy, workspace])

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
      aria-label="Switch Agents to Another Provider"
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
              <div className="text-[13px] text-ink">Switch Agents to Another Provider</div>
              <div className="mt-1 text-[11px] text-muted">
                Move a batch of agents between Claude and Codex — e.g. when you hit a usage
                limit. History is translated; the originals stay on disk.
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

          {batch && (
            <div className="mt-3 flex items-center justify-between gap-3 border border-border bg-canvas px-3 py-2">
              <div className="min-w-0 text-[11px] text-ink-dim">
                <span className="text-ink">↩ Last batch</span> — {batch.agents.length} agent
                {batch.agents.length === 1 ? '' : 's'} · {providerLabel(batch.sourceKind)} →{' '}
                {providerLabel(batch.targetKind)} · {relativeTime(batch.switchedAt)}
              </div>
              <button
                type="button"
                onClick={() => void runReturn()}
                disabled={busy}
                className="flex-shrink-0 px-2.5 py-1 text-[11px] border border-accent/60 bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-50"
              >
                {busy ? 'Working…' : `Return ${batch.agents.length}`}
              </button>
            </div>
          )}

          <div className="mt-4 grid grid-cols-[minmax(220px,1fr)_minmax(220px,1fr)] gap-3">
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-muted">
                Switch
              </label>
              <div className="mt-1">
                <select
                  value={target}
                  onChange={e => setTarget(e.target.value as AgentProviderKind)}
                  className="px-2 py-1.5 bg-canvas border border-border text-[12px] text-ink outline-none focus:border-accent"
                >
                  <option value="claude">Codex → Claude</option>
                  <option value="codex">Claude → Codex</option>
                </select>
              </div>
            </div>

            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted">Project scope</div>
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
                  No {providerLabel(source)} agents.
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
                        <span className="block text-[10px] text-muted truncate">{project.cwd}</span>
                      </span>
                      <span className="flex-shrink-0 text-[10px] text-muted tabular-nums">
                        {project.total}
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
                <div className="text-[11px] text-ink">
                  Will switch · {matchingRows.length} agent{matchingRows.length === 1 ? '' : 's'}
                </div>
                <div className="mt-0.5 text-[10px] text-muted">
                  {matchingRows.length === 0
                    ? `No ${providerLabel(source)} agents to switch.`
                    : `These ${providerLabel(source)} agents will become ${providerLabel(target)} agents.`}
                </div>
              </div>
              {scopeMode === 'selected' && (
                <div className="text-[10px] text-muted">{selectedCount} selected</div>
              )}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto">
              {matchingRows.length === 0 ? (
                <div className="px-4 py-10 text-center text-[12px] text-muted">
                  No {providerLabel(source)} agents match the current scope.
                </div>
              ) : (
                matchingRows.map(row => (
                  <div
                    key={row.sessionId}
                    className="flex items-start gap-3 px-4 py-2.5 border-b border-border last:border-b-0"
                  >
                    <div className="flex-shrink-0 w-[72px] flex items-center gap-2">
                      <span className={row.isLive ? 'text-amber-300' : 'text-muted'}>
                        {providerGlyph(row.kind)}
                      </span>
                      <span className="text-[11px] uppercase tracking-wider text-muted">
                        {row.kind}
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] text-ink truncate">{row.cwdBase}</div>
                      <div className="mt-0.5 text-[10px] text-muted truncate">
                        tab {row.tabIndex + 1} · {row.tabTitle} · {row.cwd}
                      </div>
                    </div>
                    <div className="flex-shrink-0 w-[110px] text-right">
                      {row.isLive ? (
                        <div className="text-[11px] text-amber-300">working</div>
                      ) : (
                        <div className="text-[11px] text-ink-dim">idle</div>
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
            {midTurnCount > 0
              ? `⚠ ${midTurnCount} of ${matchingRows.length} are mid-turn and will be interrupted when they respawn.`
              : 'Terminals are never switched.'}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="px-3 py-1.5 text-[11px] border border-border text-ink-dim hover:text-ink hover:border-border-hi disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void runSwitch()}
              disabled={busy || matchingRows.length === 0}
              className={`
                px-3 py-1.5 text-[11px] border
                ${matchingRows.length > 0
                  ? 'border-accent/60 bg-accent/10 text-accent hover:bg-accent/20'
                  : 'border-border text-muted opacity-60 cursor-not-allowed'}
              `}
            >
              {busy
                ? 'Switching…'
                : `Switch ${matchingRows.length} to ${providerLabel(target)}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
