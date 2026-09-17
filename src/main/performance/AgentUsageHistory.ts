import type { MonitorAgentUsage, MonitorCompositionSample, MonitorSessionUsage, MonitorUsagePoint, MonitorUsageSplit } from '@shared/performance/agentUsage.js'
import type { MonitorProcessPage, MonitorProcessRow } from '@shared/performance/processSnapshot.js'
import { MONITOR_POLICY } from '@shared/performance/monitorPolicy.js'

// Process pages arrive every MONITOR_POLICY.sampleMs (5 s), so fifteen minutes
// is 180 samples. The age cut handles irregular cadence (a stalled helper); the
// count cut bounds memory even if the clock misbehaves.
const HISTORY_SAMPLES = Math.ceil(MONITOR_POLICY.recentMs / MONITOR_POLICY.sampleMs)
// A session gone for longer than the window has nothing left to chart.
// Tracking is capped so a long run that churned through thousands of short
// orchestration agents cannot grow this map without bound.
const SESSION_LIMIT = 256
const ELECTRON_TYPES = new Set<MonitorProcessRow['type']>(['main', 'renderer', 'gpu', 'utility', 'other'])

type Tracked = { usage: Omit<MonitorSessionUsage, 'history'>; history: MonitorUsagePoint[]; seenAt: number }

const split = (): MonitorUsageSplit => ({ memoryBytes: 0, cpuPercent: 0 })
function add(target: MonitorUsageSplit, row: MonitorProcessRow): void {
  if (row.memoryBytes !== null) target.memoryBytes += row.memoryBytes
  if (row.cpuPercent !== null) target.cpuPercent += row.cpuPercent
}

/** Attribute one process page to app / agents / terminals / shared / other and
 * to individual sessions. Pure, so the attribution rules are testable without
 * a helper process. See MonitorCompositionSample for why these buckets. */
export function summarizeProcessPage(page: MonitorProcessPage): { composition: MonitorCompositionSample; sessions: Map<string, Omit<MonitorSessionUsage, 'history'>> } {
  const composition: MonitorCompositionSample = {
    at: page.summary.sampledAt, total: split(), app: split(), agents: split(), terminals: split(), shared: split(), other: split(),
  }
  const sessions = new Map<string, Omit<MonitorSessionUsage, 'history'>>()
  for (const row of page.rows) {
    add(composition.total, row)
    if (row.sharedSessionCount > 1) { add(composition.shared, row); continue }
    const sessionId = row.sharedSessionCount === 1 ? row.sessionIds[0] : undefined
    if (!sessionId) {
      add(ELECTRON_TYPES.has(row.type) ? composition.app : composition.other, row)
      continue
    }
    const kind = row.type === 'terminal' || row.provider === 'terminal' ? 'terminal' : 'agent'
    add(kind === 'terminal' ? composition.terminals : composition.agents, row)
    const entry = sessions.get(sessionId) ?? { sessionId, kind, processCount: 0, memoryBytes: null, cpuPercent: null, complete: true }
    if (row.provider && !entry.provider) entry.provider = row.provider
    // Children carry no provider; the root row's type is the authority.
    if (row.type === 'terminal') entry.kind = 'terminal'
    if (row.pid !== null) entry.processCount++
    if (row.memoryBytes === null || row.cpuPercent === null) entry.complete = false
    if (row.memoryBytes !== null) entry.memoryBytes = (entry.memoryBytes ?? 0) + row.memoryBytes
    if (row.cpuPercent !== null) entry.cpuPercent = (entry.cpuPercent ?? 0) + row.cpuPercent
    sessions.set(sessionId, entry)
  }
  return { composition, sessions }
}

/** Fifteen minutes of per-agent memory and CPU, kept in main next to the
 * process page it is derived from.
 *
 * WHY main and not the renderer: the question the monitor opens with is
 * "which agent has been growing", and that needs the minutes BEFORE the user
 * opened the panel. WHY main and not the helper: main already holds the full
 * page for UI reads, the work is one linear pass every five seconds, and
 * helper query replies are capped at 256 KiB, which fifteen minutes of history
 * for a large fleet would exceed. */
export class AgentUsageHistory {
  private composition: MonitorCompositionSample[] = []
  private sessions = new Map<string, Tracked>()
  private lastAt = -Infinity
  private quality: MonitorAgentUsage['quality'] = 'warming-up'

  record(page: MonitorProcessPage): void {
    const at = page.summary.sampledAt
    // A restarted helper can resend the page already recorded. A sample from
    // before the newest one is a clock step; appending it would break the
    // time order every chart and delta relies on.
    if (!(at > this.lastAt)) return
    this.lastAt = at
    this.quality = page.summary.quality
    const { composition, sessions } = summarizeProcessPage(page)
    this.composition.push(composition)
    const cutoff = at - MONITOR_POLICY.recentMs
    while (this.composition.length > HISTORY_SAMPLES || (this.composition[0] && this.composition[0].at < cutoff)) this.composition.shift()
    for (const [sessionId, usage] of sessions) {
      let tracked = this.sessions.get(sessionId)
      if (!tracked) {
        if (this.sessions.size >= SESSION_LIMIT) this.evictOldest()
        tracked = { usage, history: [], seenAt: at }
        this.sessions.set(sessionId, tracked)
      }
      tracked.usage = usage
      tracked.seenAt = at
      tracked.history.push([at, usage.memoryBytes, usage.cpuPercent])
      while (tracked.history.length > HISTORY_SAMPLES || tracked.history[0]![0] < cutoff) tracked.history.shift()
    }
    for (const [sessionId, tracked] of this.sessions) if (tracked.seenAt < cutoff) this.sessions.delete(sessionId)
  }

  /** Only sessions present in the newest page are returned: an exited agent's
   * last reading would otherwise sit in the ranking as if it still used RAM. */
  read(systemMemoryBytes: number): MonitorAgentUsage {
    const sessions: MonitorSessionUsage[] = []
    for (const tracked of this.sessions.values()) {
      if (tracked.seenAt !== this.lastAt) continue
      sessions.push({ ...tracked.usage, history: tracked.history.slice() })
    }
    sessions.sort((a, b) => (b.memoryBytes ?? -1) - (a.memoryBytes ?? -1))
    return {
      sampledAt: Number.isFinite(this.lastAt) ? this.lastAt : 0, quality: this.quality, systemMemoryBytes,
      composition: this.composition.slice(), sessions,
    }
  }

  clear(): void {
    this.composition = []
    this.sessions.clear()
    this.lastAt = -Infinity
  }

  private evictOldest(): void {
    let oldest: string | null = null
    let oldestAt = Infinity
    for (const [sessionId, tracked] of this.sessions) if (tracked.seenAt < oldestAt) { oldest = sessionId; oldestAt = tracked.seenAt }
    if (oldest !== null) this.sessions.delete(oldest)
  }
}
