import pidtree from 'pidtree'
import pidusage from 'pidusage'

import type { SessionManager } from '@main/sessionManager.js'
import { performanceService } from '@main/performance/PerformanceService.js'
import type {
  PanePerformanceSnapshot,
  PanePerformanceStats,
} from '@shared/performance/types.js'

type UsageStat = {
  cpu: number
  memory: number
}

export class ProcessTelemetry {
  constructor(private readonly manager: SessionManager) {}

  async snapshot(sessionIds?: string[]): Promise<PanePerformanceSnapshot> {
    const sampledAt = Date.now()
    const enabled = performanceService.getConfig().enabled
    if (!enabled) {
      return { enabled: false, sampledAt, panes: [] }
    }

    const targets = this.manager.getProcessTelemetryTargets(sessionIds)
    const panes = await Promise.all(
      targets.map(async target => {
        if (!target.pid || target.exited) {
          return {
            sessionId: target.sessionId,
            kind: target.kind,
            status: target.exited ? 'exited' : 'unknown',
            rootPid: target.pid,
            cpuPercent: null,
            memoryBytes: null,
            childCount: 0,
            lastActivityAt: target.lastActivityAt,
            sampledAt,
          } satisfies PanePerformanceStats
        }

        try {
          const pids = await pidtree(target.pid, { root: true })
          const usage = await pidusage(pids)
          const stats = Array.isArray(pids)
            ? pids.map(pid => usage[String(pid)]).filter(Boolean)
            : []
          const totals = stats.reduce<UsageStat>(
            (acc, stat) => ({
              cpu: acc.cpu + stat.cpu,
              memory: acc.memory + stat.memory,
            }),
            { cpu: 0, memory: 0 },
          )
          return {
            sessionId: target.sessionId,
            kind: target.kind,
            status: target.exited ? 'exited' : activityStatus(target.lastActivityAt, sampledAt),
            rootPid: target.pid,
            cpuPercent: totals.cpu,
            memoryBytes: totals.memory,
            childCount: Math.max(0, pids.length - 1),
            lastActivityAt: target.lastActivityAt,
            sampledAt,
          } satisfies PanePerformanceStats
        } catch {
          return {
            sessionId: target.sessionId,
            kind: target.kind,
            status: target.exited ? 'exited' : 'unknown',
            rootPid: target.pid,
            cpuPercent: null,
            memoryBytes: null,
            childCount: 0,
            lastActivityAt: target.lastActivityAt,
            sampledAt,
          } satisfies PanePerformanceStats
        }
      }),
    )

    await performanceService.recordPaneProcessStats(panes)
    return { enabled: true, sampledAt, panes }
  }
}

function activityStatus(
  lastActivityAt: number | null,
  sampledAt: number,
): PanePerformanceStats['status'] {
  if (!lastActivityAt) return 'unknown'
  return sampledAt - lastActivityAt > 30_000 ? 'idle' : 'running'
}
