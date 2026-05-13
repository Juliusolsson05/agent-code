import { useEffect, useMemo, useState } from 'react'

import type { PanePerformanceStats } from '@shared/performance/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { resolveTabSessions } from '@renderer/workspace/queries'
import { paneLabelForSession } from '@renderer/workspace/tile-tree/paneLabels'

type Props = {
  open: boolean
  workspace: Workspace
}

export function PerformancePanel({ open, workspace }: Props) {
  const visible = useMemo(
    () =>
      workspace.tileTabs
        ? workspace.tileTabs.tabIds
            .map(id => workspace.state.tabs.find(tab => tab.id === id))
            .filter((tab): tab is NonNullable<typeof tab> => Boolean(tab))
        : workspace.activeTab
          ? [workspace.activeTab]
          : [],
    [workspace.activeTab, workspace.state.tabs, workspace.tileTabs],
  )
  const visibleIds = useMemo(
    () => visible.flatMap(tab => resolveTabSessions(workspace.state, tab.id)),
    [visible, workspace.state],
  )
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [stats, setStats] = useState<PanePerformanceStats[]>([])

  useEffect(() => {
    if (!open || visibleIds.length === 0) {
      setStats([])
      return
    }
    let cancelled = false
    const tick = async () => {
      try {
        const snapshot = await window.api.getPanePerformanceStats(visibleIds)
        if (cancelled) return
        setEnabled(snapshot.enabled)
        setStats(snapshot.panes)
      } catch {
        if (!cancelled) {
          setEnabled(false)
          setStats([])
        }
      }
    }
    void tick()
    const timer = window.setInterval(() => void tick(), 2000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [open, visibleIds])

  if (!open) return null

  const bySession = new Map(stats.map(stat => [stat.sessionId, stat]))

  return (
    <div className="relative [-webkit-app-region:no-drag]">
      <div className="absolute right-0 top-full mt-1 w-[430px] max-w-[calc(100vw-24px)] border border-border bg-surface shadow-xl z-50">
        <div className="grid grid-cols-[44px_58px_72px_74px_1fr] gap-2 px-3 py-1.5 border-b border-border text-[9px] uppercase text-muted">
          <span>pane</span>
          <span>cpu</span>
          <span>memory</span>
          <span>status</span>
          <span>last</span>
        </div>
        {enabled === false ? (
          <div className="px-3 py-3 text-[11px] text-muted">
            performance telemetry off
          </div>
        ) : visibleIds.length === 0 ? (
          <div className="px-3 py-3 text-[11px] text-muted">no visible panes</div>
        ) : (
          <div className="max-h-[260px] overflow-auto">
            {visible.flatMap(tab =>
              resolveTabSessions(workspace.state, tab.id).map(sessionId => {
                const stat = bySession.get(sessionId)
                return (
                  <div
                    key={sessionId}
                    className="grid grid-cols-[44px_58px_72px_74px_1fr] gap-2 px-3 py-1.5 border-b border-border/70 last:border-b-0 text-[10px] tabular-nums"
                  >
                    <span className="font-semibold text-ink">
                      {paneLabelForSession(workspace.state.tabs, tab.id, sessionId)}
                    </span>
                    <span>{formatCpu(stat?.cpuPercent)}</span>
                    <span>{formatMemory(stat?.memoryBytes)}</span>
                    <span className={statusClass(stat?.status)}>
                      {stat?.status ?? 'unknown'}
                    </span>
                    <span>{formatLastActivity(stat?.lastActivityAt, stat?.sampledAt)}</span>
                  </div>
                )
              }),
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function formatCpu(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`
}

function formatMemory(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return `${Math.round(value / (1024 * 1024))}MB`
}

function formatLastActivity(
  lastActivityAt: number | null | undefined,
  sampledAt: number | undefined,
): string {
  if (!lastActivityAt || !sampledAt) return '—'
  const seconds = Math.max(0, Math.round((sampledAt - lastActivityAt) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`
}

function statusClass(status: PanePerformanceStats['status'] | undefined): string {
  if (status === 'running') return 'text-green-400'
  if (status === 'idle') return 'text-yellow-300'
  if (status === 'exited') return 'text-red-400'
  return 'text-muted'
}
