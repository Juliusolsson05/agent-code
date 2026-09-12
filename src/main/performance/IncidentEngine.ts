import type { MonitorEnvelope } from '@shared/performance/monitorSnapshot.js'
import type { MonitorOperationName } from '@shared/performance/monitorPolicy.js'
import type { MonitorIncident, MonitorIncidentRule, MonitorIncidentSummary, MonitorEvidencePoint } from '@shared/performance/monitorIncidents.js'

// Async/provider waits have no universal local-slowness threshold. In particular
// generic IPC may include a user dialog; elapsed time alone cannot blame main.
const operationThresholds: Partial<Record<MonitorOperationName, number>> = {
  'transcript.read': 1000, 'transcript.parse': 100, 'transcript.fold': 100,
  'transcript.commit': 100, 'terminal.write': 250, 'persistence.serialize': 100,
  'persistence.write': 2000, 'worktree.refresh': 5000,
}
type Capture = { incident: MonitorIncident; endAt: number }

/** Worker-only deterministic observations; no automatic profiler or payloads. */
export class IncidentEngine {
  private evidence: MonitorEvidencePoint[] = []
  private incidents: MonitorIncident[] = []
  private active: Capture | null = null
  private sequence = 0
  private cooldown = new Map<string, number>()
  private mainWindows: Array<{ at: number; slow: boolean; value: number }> = []
  private lastMainAt = -Infinity
  private sleepUntil = -Infinity
  private heapHigh = 0
  private heapAt = -Infinity
  private windowState = new Map<number, { at: number; visible: boolean; slow: number[] }>()
  private visibleWindows: Set<number> | null = null
  private drops = 0

  accept(records: MonitorEnvelope[], wall: number, mono: number): void {
    if (this.active && mono >= this.active.endAt) { this.active.incident.state = 'complete'; this.active = null }
    for (const record of records) {
      if (record.kind === 'main') {
        const sample = record.sample
        this.lastMainAt = mono
        this.add({ at: sample.at, kind: 'main', scope: 0, value: sample.loopMaxMs, cpuPercent: sample.cpuPercent,
          heapRatio: sample.heapLimit ? sample.heapUsed / sample.heapLimit : null, longTaskMs: null, sleepGap: sample.sleepGap })
        if (sample.sleepGap) {
          this.sleepUntil = mono + 5000; this.mainWindows = []; this.heapHigh = 0
          for (const state of this.windowState.values()) { state.at = mono; state.slow = [] }
          continue
        }
        if (mono < this.sleepUntil) continue
        this.mainWindows = [...this.mainWindows.filter(row => mono - row.at < 5000), { at: mono, slow: (sample.loopMaxMs ?? 0) > 100, value: sample.loopMaxMs ?? 0 }].slice(-5)
        if ((sample.loopMaxMs ?? 0) >= 1000 || (this.mainWindows.length >= 5 && this.mainWindows.filter(row => row.slow).length >= 3)) {
          this.trigger('main-stall', 0, Math.max(...this.mainWindows.map(row => row.value)), (sample.loopMaxMs ?? 0) >= 1000 ? 1000 : 100, wall, mono)
        }
        // Main memory is cached for five seconds. Counting every loop tick
        // would turn one heap observation into three independent samples.
        if (mono - this.heapAt >= 5000) {
          this.heapAt = mono
          const ratio = sample.heapLimit ? sample.heapUsed / sample.heapLimit : 0
          this.heapHigh = ratio >= 0.7 ? this.heapHigh + 1 : ratio < 0.6 ? 0 : this.heapHigh
          if (this.heapHigh >= 3) this.trigger('memory-pressure', 0, ratio, 0.7, wall, mono)
        }
      } else if (record.kind === 'window') {
        const sample = record.sample
        const state = this.windowState.get(sample.windowId) ?? { at: mono, visible: false, slow: [] }
        // Main's BrowserWindow lifecycle is authoritative for whether missing
        // renderer evidence is actionable. A delayed renderer heartbeat must
        // not classify a hidden window as visible.
        state.at = mono; state.visible = this.visibleWindows?.has(sample.windowId) ?? sample.visibility === 'visible'
        if (this.windowState.size < 64 || this.windowState.has(sample.windowId)) this.windowState.set(sample.windowId, state)
        this.add({ at: sample.receivedAt, kind: 'window', scope: sample.windowId, value: sample.lagMs, cpuPercent: null,
          heapRatio: sample.heapLimitBytes ? (sample.heapUsedBytes ?? 0) / sample.heapLimitBytes : null,
          longTaskMs: sample.longTasksSupported ? sample.longTaskTotalMs : null, sleepGap: mono < this.sleepUntil })
        if (!state.visible || mono < this.sleepUntil || (this.visibleWindows && !this.visibleWindows.has(sample.windowId))) { state.slow = []; continue }
        if (sample.lagMs >= 1000) this.trigger('renderer-stall', sample.windowId, sample.lagMs, 1000, wall, mono)
        state.slow = state.slow.filter(at => mono - at < 5000)
        if (sample.longTasksSupported && sample.longTaskTotalMs >= 200) state.slow.push(mono)
        if (state.slow.length >= 3) this.trigger('renderer-long-tasks', sample.windowId, sample.longTaskTotalMs, 200, wall, mono)
      } else if (record.kind === 'operation') {
        const threshold = operationThresholds[record.sample.name]
        if (threshold !== undefined && record.sample.outcome !== 'cancelled' && record.sample.durationMs >= threshold && mono >= this.sleepUntil) {
          this.trigger('slow-operation', record.windowId ?? 0, record.sample.durationMs, threshold, wall, mono, record.sample.name)
        }
      }
    }
    this.tick(wall, mono)
  }
  reconcile(liveIds: number[], visibleIds: number[], mono: number): void {
    const live = new Set(liveIds)
    this.visibleWindows = new Set(visibleIds)
    for (const id of this.windowState.keys()) if (!live.has(id)) this.windowState.delete(id)
    for (const id of live) {
      const visible = this.visibleWindows.has(id)
      const state = this.windowState.get(id)
      if (!state) {
        // Start the clock from main's first observation of a live window.
        // Otherwise a renderer that never boots can never produce an incident.
        this.windowState.set(id, { at: mono, visible, slow: [] })
      } else {
        // A newly shown window gets a full heartbeat grace interval. Reusing
        // its hidden timestamp would report a stall the instant it opens.
        if (visible && !state.visible) state.at = mono
        state.visible = visible
        if (!visible) state.slow = []
      }
    }
    for (const key of this.cooldown.keys()) {
      const scope = Number(key.split(':')[1])
      if (scope && !live.has(scope)) this.cooldown.delete(key)
    }
  }
  loss(count: number, wall: number, mono: number): void {
    if (count > this.drops) this.trigger('monitoring-loss', 0, count - this.drops, 1, wall, mono)
    this.drops = count
  }
  tick(wall: number, mono: number): void {
    if (this.active && mono >= this.active.endAt) { this.active.incident.state = 'complete'; this.active = null }
    // An absent renderer is not blamed while main itself cannot deliver the
    // frames, during sleep, or after Electron reports it hidden/minimized.
    if (mono < this.sleepUntil || mono - this.lastMainAt > 2500) return
    for (const [id, state] of this.windowState) if (state.visible && this.visibleWindows?.has(id) && mono - state.at > 4000) {
      this.trigger('renderer-stall', id, mono - state.at, 4000, wall, mono)
    }
  }
  summaries(): MonitorIncidentSummary[] { return this.incidents.map(({ evidence, ...summary }) => ({ ...summary, evidenceCount: evidence.length })) }
  detail(id: number): MonitorIncident | null { const incident = this.incidents.find(row => row.id === id); return incident ? { ...incident, evidence: [...incident.evidence], evidenceCount: incident.evidence.length } : null }
  interrupt(): void { if (this.active) { this.active.incident.state = 'interrupted'; this.active = null } }

  private add(point: MonitorEvidencePoint): void {
    this.evidence.push(point)
    // 64 windows + main at 1 Hz, with a count cap independent of clock jumps.
    if (this.evidence.length > 4000) this.evidence.splice(0, this.evidence.length - 4000)
    if (this.active && (point.kind === 'main' || point.scope === this.active.incident.scope)) {
      if (this.active.incident.evidence.length < 160) this.active.incident.evidence.push(point)
      else this.active.incident.truncated = true
    }
  }
  private trigger(rule: MonitorIncidentRule, scope: number, observed: number, threshold: number, wall: number, mono: number, operation?: MonitorOperationName): void {
    const key = `${rule}:${scope}`
    if (this.active || mono < (this.cooldown.get(key) ?? -Infinity)) return
    // Finite rules × 65 scopes bounds cooldown even in a long-running app.
    if (!this.cooldown.has(key) && this.cooldown.size >= 390) return
    this.cooldown.set(key, mono + 60_000)
    const candidates = this.evidence.filter(point => wall - point.at >= 0 && wall - point.at <= 60_000 && (point.kind === 'main' || point.scope === scope))
    const incident: MonitorIncident = { id: ++this.sequence, ruleVersion: 1, rule, scope, at: wall, severity: rule.endsWith('stall') ? 'error' : 'warning',
      observed, threshold, ...(operation ? { operation } : {}), state: 'capturing', truncated: candidates.length > 160, evidenceCount: 0, evidence: candidates.slice(-160) }
    this.incidents.push(incident)
    if (this.incidents.length > 50) this.incidents.shift()
    this.active = { incident, endAt: mono + 15_000 }
  }
}
