import type { MonitorHeartbeat, MonitorOperation } from './monitorContracts.js'
import type { LatencyHistogramSnapshot } from './latencyHistogram.js'
import type { MonitorOperationName, MonitorOutcome } from './monitorPolicy.js'

export type MonitorMainSample = {
  at: number; cpuPercent: number | null; rss: number; heapUsed: number; heapLimit: number
  loopMeanMs: number | null; loopP99Ms: number | null; loopMaxMs: number | null; sleepGap: boolean
}
export type MonitorWindowSample = MonitorHeartbeat & { windowId: number; receivedAt: number; longTasksSupported: boolean; inputSupported: boolean }
export type MonitorOperationSummary = {
  name: MonitorOperationName; outcome: MonitorOutcome; histogram: LatencyHistogramSnapshot
}
export type MonitorEnvelope =
  | { kind: 'main'; sample: MonitorMainSample }
  | { kind: 'window'; sample: MonitorWindowSample }
  | { kind: 'operation'; at: number; windowId: number | null; sample: MonitorOperation }
  | { kind: 'window-closed'; windowId: number }

export type MonitorWorkerSnapshot = {
  schemaVersion: 1; sampledAt: number; main: MonitorMainSample | null
  windows: MonitorWindowSample[]; operations: MonitorOperationSummary[]
  recent: MonitorMainSample[]; workerRss: number
}
export type MonitorSnapshot = MonitorWorkerSnapshot & {
  runId: string; enabled: true
  collector: 'starting' | 'healthy' | 'degraded' | 'stopped'
  droppedRecords: number; queuedBytes: number; restarts: number
}

export type MonitorWorkerRequest = { sequence: number; records: MonitorEnvelope[] }
export type MonitorWorkerResponse = { sequence: number; snapshot: MonitorWorkerSnapshot }
