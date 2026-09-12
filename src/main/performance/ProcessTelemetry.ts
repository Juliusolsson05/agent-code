import type { SessionManager } from '@main/sessionManager.js'
import { monitorCoordinator } from './MonitorCoordinator.js'
import type { PanePerformanceSnapshot, PanePerformanceStats } from '@shared/performance/types.js'

/** Compatibility reader for old diagnostics: native sampling has one owner. */
export class ProcessTelemetry {
  constructor(private readonly manager: SessionManager) {}
  async snapshot(sessionIds?: string[]): Promise<PanePerformanceSnapshot> {
    const page = monitorCoordinator.readAllProcesses()
    const panes = this.manager.getProcessTelemetryTargets(sessionIds).slice(0, 2048).map(target => {
      // Shared helpers stay in the application total and are excluded from
      // per-session totals. Charging them to each owner would double-count RSS
      // and CPU as soon as two panes share a provider process.
      const rows = page.rows.filter(row => row.sharedSessionCount === 1 && row.sessionIds.includes(target.sessionId))
      return {
        sessionId: target.sessionId, kind: target.kind, rootPid: target.pid,
        status: target.exited ? 'exited' : 'unknown',
        cpuPercent: rows.length && rows.every(row => row.cpuPercent !== null) ? rows.reduce((sum, row) => sum + row.cpuPercent!, 0) : null,
        memoryBytes: rows.length && rows.every(row => row.memoryBytes !== null) ? rows.reduce((sum, row) => sum + row.memoryBytes!, 0) : null,
        childCount: Math.max(0, rows.length - 1), lastActivityAt: target.lastActivityAt,
        sampledAt: page.summary.sampledAt,
      } satisfies PanePerformanceStats
    })
    return { enabled: true, sampledAt: page.summary.sampledAt, panes }
  }
}
