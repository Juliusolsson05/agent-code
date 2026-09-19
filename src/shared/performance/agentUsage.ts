import type { SessionKind } from '../types/providerKind.js'
import type { MonitorProcessSummary } from './processSnapshot.js'

/** Memory and CPU for one slice of the application. Both are sums over the
 * process rows in that slice that actually reported a value; a row without
 * a reading contributes nothing rather than being guessed. */
export type MonitorUsageSplit = { memoryBytes: number; cpuPercent: number }

/** Where the application's resources went at one process sample.
 *
 * WHY these five buckets: they are the only attributions the sampler can make
 * honestly. `app` is Electron itself (main, renderers, GPU, utilities). A row
 * owned by exactly one session belongs to that agent or terminal, including
 * its descendants (MCP servers, builds it spawned). A row reachable from
 * several sessions is `shared` and is counted once here, never charged to
 * each owner. `other` is an unowned descendant, kept visible so the buckets
 * always add up to `total`. */
export type MonitorCompositionSample = {
  at: number
  total: MonitorUsageSplit
  app: MonitorUsageSplit
  agents: MonitorUsageSplit
  terminals: MonitorUsageSplit
  shared: MonitorUsageSplit
  other: MonitorUsageSplit
}

/** `[at, memoryBytes, cpuPercent]`, compact because every live session carries
 * up to fifteen minutes of these across IPC on each poll. */
export type MonitorUsagePoint = [at: number, memoryBytes: number | null, cpuPercent: number | null]

export type MonitorSessionUsage = {
  sessionId: string
  kind: 'agent' | 'terminal'
  provider?: SessionKind
  /** Real processes owned by this session alone. Placeholder rows for a root
   * that could not be discovered are not processes and are not counted. */
  processCount: number
  memoryBytes: number | null
  cpuPercent: number | null
  /** False when some owned process had no reading, so the totals are a floor. */
  complete: boolean
  history: MonitorUsagePoint[]
}

export type MonitorAgentUsage = {
  sampledAt: number
  quality: MonitorProcessSummary['quality']
  /** Physical memory of this machine, for "share of system RAM". Deliberately
   * not free memory: macOS compresses and caches aggressively, so a low free
   * figure is normal and would be read as pressure that is not there. */
  systemMemoryBytes: number
  composition: MonitorCompositionSample[]
  sessions: MonitorSessionUsage[]
}
