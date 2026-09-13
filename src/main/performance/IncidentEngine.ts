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
// Each capture retains at most 160 evidence points. Eight simultaneous scopes
// bound post-trigger memory to ~1.3k points even during an app-wide storm,
// while still letting unrelated windows record their own incidents.
const CAPTURE_LIMIT = 8
const HEARTBEAT_STALE_MS = 4000
// A window that has never heartbeated is still loading its bundle, preload and
// first render. Main now registers windows as expected-visible from creation
// (so a renderer that hangs before first paint is detectable), and a cold
// start routinely takes longer than one heartbeat interval; four seconds would
// report every slow launch as a stall.
const BOOT_GRACE_MS = 15_000
type Capture = { incident: MonitorIncident; endAt: number }
type WindowState = { at: number; sourceAt: number; visible: boolean; heartbeated: boolean; slow: number[] }

/** Worker-only deterministic observations; no automatic profiler or payloads. */
export class IncidentEngine {
  private evidence: MonitorEvidencePoint[] = []
  private incidents: MonitorIncident[] = []
  // WHY keyed by rule AND scope instead of one global capture: a single
  // app-wide slot let a 15-second capture for window A (or the former
  // monitoring-loss rule) silently swallow a genuine main stall or a stall in
  // window B. Scope alone is not enough either: main-stall, memory-pressure and
  // every main-process slow-operation share scope 0, so a routine slow parse
  // would hide an error-severity stall seconds later. Only a repeat of the SAME
  // rule in the same scope coalesces into the open capture.
  private captures = new Map<string, Capture>()
  private sequence = 0
  private cooldown = new Map<string, number>()
  private mainWindows: Array<{ at: number; slow: boolean; value: number }> = []
  private lastMainAt = -Infinity
  // Main's own wall timestamp for its newest sample. Heartbeat staleness is
  // judged against this SOURCE clock as well as the helper's receive clock: a
  // transport backlog delays both heartbeats and main samples equally, so
  // comparing the times main stamped them keeps delivery lag from being
  // misreported as a renderer stall.
  private lastMainSourceAt = -Infinity
  private sleepUntil = -Infinity
  private heapHigh = 0
  private heapAt = -Infinity
  private windowState = new Map<number, WindowState>()
  private visibleWindows: Set<number> | null = null
  private drops: number | null = null
  private livenessDrops: number | null = null
  private livenessLossAt = -Infinity

  accept(records: MonitorEnvelope[], wall: number, mono: number): void {
    this.complete(mono)
    for (const record of records) {
      if (record.kind === 'main') {
        const sample = record.sample
        this.lastMainAt = mono
        if (sample.at < this.lastMainSourceAt - HEARTBEAT_STALE_MS) {
          // The wall clock stepped backwards. Source clocks only ever moved
          // forward, so every heartbeat age would read ~0 until wall time
          // caught up (an hour after a one-hour step) and stalls went unseen.
          // Rebase main and every window onto the new clock instead.
          this.lastMainSourceAt = sample.at
          for (const state of this.windowState.values()) state.sourceAt = sample.at
        } else this.lastMainSourceAt = Math.max(this.lastMainSourceAt, sample.at)
        for (const state of this.windowState.values()) if (!Number.isFinite(state.sourceAt)) state.sourceAt = sample.at
        this.add({ at: sample.at, kind: 'main', scope: 0, value: sample.loopMaxMs, cpuPercent: sample.cpuPercent,
          heapRatio: sample.heapLimit ? sample.heapUsed / sample.heapLimit : null, longTaskMs: null, sleepGap: sample.sleepGap })
        if (sample.sleepGap) {
          this.sleepUntil = mono + 5000; this.mainWindows = []; this.heapHigh = 0
          for (const state of this.windowState.values()) { state.at = mono; state.sourceAt = sample.at; state.slow = [] }
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
        const state = this.windowState.get(sample.windowId) ?? { at: mono, sourceAt: sample.receivedAt, visible: false, heartbeated: true, slow: [] }
        // Main's BrowserWindow lifecycle is authoritative for whether missing
        // renderer evidence is actionable. A delayed renderer heartbeat must
        // not classify a hidden window as visible.
        state.at = mono; state.sourceAt = Math.max(Number.isFinite(state.sourceAt) ? state.sourceAt : 0, sample.receivedAt); state.heartbeated = true
        state.visible = this.visibleWindows?.has(sample.windowId) ?? sample.visibility === 'visible'
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
        // Main registers a window when BrowserWindow is created, before its
        // renderer can heartbeat. Starting the clock here is what lets a
        // renderer that never boots produce an incident at all.
        if (this.windowState.size < 64) this.windowState.set(id, { at: mono, sourceAt: this.lastMainSourceAt, visible, heartbeated: false, slow: [] })
      } else {
        // A newly shown window gets a full heartbeat grace interval. Reusing
        // its hidden timestamp would report a stall the instant it opens.
        if (visible && !state.visible) { state.at = mono; state.sourceAt = this.lastMainSourceAt }
        state.visible = visible
        if (!visible) state.slow = []
      }
    }
    for (const key of this.cooldown.keys()) {
      const scope = Number(key.split(':')[1])
      if (scope && !live.has(scope)) this.cooldown.delete(key)
    }
  }
  /** Loss is coverage, not an incident. A former `monitoring-loss` rule took the
   * capture slot and one of the fifty retained incidents for every overload,
   * evicting the real stalls that overload usually accompanies. Drops now mark
   * any open capture as incomplete; totals stay visible in history coverage. */
  loss(total: number, liveness: number, mono: number): void {
    // Both counters are cumulative for the whole app run, but a restarted
    // helper builds a fresh engine. Its first report is a baseline: counting
    // it as new loss marked captures from the restarted helper's first batch
    // truncated for drops that happened before they existed.
    if (this.drops !== null && total > this.drops) {
      for (const capture of this.captures.values()) capture.incident.truncated = true
    }
    if (this.livenessDrops !== null && liveness > this.livenessDrops) this.livenessLossAt = mono
    this.drops = Math.max(this.drops ?? 0, total)
    this.livenessDrops = Math.max(this.livenessDrops ?? 0, liveness)
  }
  tick(wall: number, mono: number): void {
    this.complete(mono)
    // An absent renderer is not blamed while main itself cannot deliver the
    // frames, during sleep, or after Electron reports it hidden/minimized.
    if (mono < this.sleepUntil || mono - this.lastMainAt > 2500) return
    for (const [id, state] of this.windowState) {
      if (!state.visible || !this.visibleWindows?.has(id)) continue
      // Both clocks must agree. Receive age alone blames transport backlog;
      // source age alone can be fooled by a wall-clock step between samples.
      const receiveAge = mono - state.at
      const sourceAge = Number.isFinite(state.sourceAt) ? this.lastMainSourceAt - state.sourceAt : receiveAge
      const limit = state.heartbeated ? HEARTBEAT_STALE_MS : BOOT_GRACE_MS
      // Liveness evidence was dropped after this window's last delivered
      // heartbeat, so its silence may be a lost heartbeat rather than a stalled
      // renderer. The excuse is deliberately narrow: only drops that can hold a
      // heartbeat count (operation-queue loss cannot remove one), and only for
      // one staleness interval. An unbounded excuse let a single unrelated drop
      // hide a frozen renderer for as long as it stayed frozen.
      if (this.livenessLossAt > state.at && mono - this.livenessLossAt <= limit) continue
      if (receiveAge > limit && sourceAge > limit) {
        this.trigger('renderer-stall', id, Math.min(receiveAge, sourceAge), limit, wall, mono)
      }
    }
  }
  summaries(): MonitorIncidentSummary[] { return this.incidents.map(({ evidence, ...summary }) => ({ ...summary, evidenceCount: evidence.length })) }
  detail(id: number): MonitorIncident | null { const incident = this.incidents.find(row => row.id === id); return incident ? { ...incident, evidence: [...incident.evidence], evidenceCount: incident.evidence.length } : null }
  interrupt(): void {
    for (const capture of this.captures.values()) capture.incident.state = 'interrupted'
    this.captures.clear()
  }
  /** Clear History deletes incident evidence on disk. The pre-trigger ring and
   * retained incidents are the same evidence in memory; keeping them would
   * re-persist deleted incidents on the next snapshot and seed new captures
   * with samples from before the user's clear. Sequence keeps counting so
   * `at:id` identities stay unique within the run. */
  clear(): void {
    this.evidence = []
    this.incidents = []
    this.captures.clear()
    this.cooldown.clear()
  }

  private complete(mono: number): void {
    for (const [key, capture] of this.captures) if (mono >= capture.endAt) {
      capture.incident.state = 'complete'
      this.captures.delete(key)
    }
  }
  private add(point: MonitorEvidencePoint): void {
    this.evidence.push(point)
    // 64 windows + main at 1 Hz, with a count cap independent of clock jumps.
    if (this.evidence.length > 4000) this.evidence.splice(0, this.evidence.length - 4000)
    for (const capture of this.captures.values()) {
      if (point.kind !== 'main' && point.scope !== capture.incident.scope) continue
      if (capture.incident.evidence.length < 160) capture.incident.evidence.push(point)
      else capture.incident.truncated = true
    }
  }
  private trigger(rule: MonitorIncidentRule, scope: number, observed: number, threshold: number, wall: number, mono: number, operation?: MonitorOperationName): void {
    const key = `${rule}:${scope}`
    if (this.captures.has(key) || this.captures.size >= CAPTURE_LIMIT || mono < (this.cooldown.get(key) ?? -Infinity)) return
    // Finite rules × 65 scopes bounds cooldown even in a long-running app.
    if (!this.cooldown.has(key) && this.cooldown.size >= 390) return
    this.cooldown.set(key, mono + 60_000)
    const candidates = this.evidence.filter(point => wall - point.at >= 0 && wall - point.at <= 60_000 && (point.kind === 'main' || point.scope === scope))
    const incident: MonitorIncident = { id: ++this.sequence, ruleVersion: 1, rule, scope, at: wall, severity: rule.endsWith('stall') ? 'error' : 'warning',
      observed, threshold, ...(operation ? { operation } : {}), state: 'capturing', truncated: candidates.length > 160, evidenceCount: 0, evidence: candidates.slice(-160) }
    this.incidents.push(incident)
    if (this.incidents.length > 50) this.incidents.shift()
    this.captures.set(key, { incident, endAt: mono + 15_000 })
  }
}
