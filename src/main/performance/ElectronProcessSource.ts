import { app } from 'electron'
import { MONITOR_POLICY } from '@shared/performance/monitorPolicy.js'
import { isMonitorId } from '@shared/performance/monitorContracts.js'
import type { MonitorEnvelope } from '@shared/performance/monitorSnapshot.js'
import type { MonitorElectronProcess, MonitorProcessTarget } from '@shared/performance/processSnapshot.js'

let latestElectron: MonitorElectronProcess[] = []
export function readElectronProcesses(): MonitorElectronProcess[] { return latestElectron }

/** Sole owner of getAppMetrics' stateful CPU intervals; readers only use its cache. */
export class ElectronProcessSource {
  private timer: ReturnType<typeof setInterval> | null = null
  private generation = 0
  private previous = new Set<string>()

  constructor(private readonly targets: () => MonitorProcessTarget[], private readonly emit: (record: MonitorEnvelope) => void) {}

  start(): void {
    if (this.timer) return
    this.sample()
    this.timer = setInterval(() => this.sample(), MONITOR_POLICY.sampleMs)
    this.timer.unref()
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null }

  private sample(): void {
    try {
      const now = Date.now()
      const identities = new Set<string>()
      const metrics = app.getAppMetrics()
      latestElectron = metrics.slice(0, MONITOR_POLICY.windowLimit * 4).map(metric => {
        const identity = `${metric.pid}:${metric.creationTime}`
        identities.add(identity)
        const type: MonitorElectronProcess['type'] = metric.type === 'Browser' ? 'main'
          : metric.type === 'Tab' ? 'renderer' : metric.type === 'GPU' ? 'gpu' : metric.type === 'Utility' ? 'utility' : 'other'
        return {
          pid: metric.pid, creationTime: metric.creationTime, type,
          cpuPercent: this.previous.has(identity) && Number.isFinite(metric.cpu.percentCPUUsage) ? Math.max(0, metric.cpu.percentCPUUsage) : null,
          memoryBytes: Number.isFinite(metric.memory.workingSetSize) ? metric.memory.workingSetSize * 1024 : null,
        }
      })
      this.previous = identities
      const allTargets = this.targets()
      const targets = allTargets.slice(0, MONITOR_POLICY.processLimit).filter(target => isMonitorId(target.sessionId)).map(target => ({
        sessionId: target.sessionId, kind: target.kind, pid: target.pid,
        exited: target.exited, lastActivityAt: target.lastActivityAt,
      }))
      const generation = ++this.generation
      // Context travels as ordinary bounded records. The helper only commits
      // a complete generation, so losing one record under pressure yields stale
      // coverage rather than silently attributing a partial fleet as complete.
      this.emit({ kind: 'process-context-start', generation, rootPid: process.pid, sampledAt: now, expected: targets.length + latestElectron.length, truncated: allTargets.length > targets.length || metrics.length > latestElectron.length })
      for (const sample of latestElectron) this.emit({ kind: 'process-electron', generation, sample })
      for (const sample of targets) this.emit({ kind: 'process-target', generation, sample })
      this.emit({ kind: 'process-context-end', generation })
    } catch { /* Cache timestamps expose failed native samples as stale coverage. */ }
  }
}
