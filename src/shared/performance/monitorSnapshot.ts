import type { MonitorIncidentSummary } from './monitorIncidents.js'
import type { MonitorHistoryStatus, MonitorWorkerQuery, MonitorWorkerQueryResult } from './monitorHistory.js'
import type { MonitorElectronProcess, MonitorProcessTarget, MonitorProcessChunk, MonitorProcessSummary } from './processSnapshot.js'
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
  | { kind: 'process-context-start'; generation: number; rootPid: number; sampledAt: number; expected: number; truncated?: boolean }
  | { kind: 'process-electron'; generation: number; sample: MonitorElectronProcess }
  | { kind: 'process-target'; generation: number; sample: MonitorProcessTarget }
  | { kind: 'process-context-end'; generation: number }

export type MonitorWorkerSnapshot = {
  schemaVersion: 1; sampledAt: number; main: MonitorMainSample | null
  windows: MonitorWindowSample[]; operations: MonitorOperationSummary[]
  recent: MonitorMainSample[]; workerRss: number; incidents?: MonitorIncidentSummary[]; history?: MonitorHistoryStatus
}
export type MonitorSnapshot = MonitorWorkerSnapshot & {
  runId: string; enabled: true
  collector: 'starting' | 'healthy' | 'degraded' | 'stopped'
  droppedRecords: number; queuedBytes: number; restarts: number
  processes?: MonitorProcessSummary
}

export type MonitorWorkerRequest = { sequence: number; runId: string; historyRoot: string; restarts: number; records: MonitorEnvelope[]; liveWindowIds?: number[]; visibleWindowIds?: number[]; droppedRecords?: number; query?: MonitorWorkerQuery }
export type MonitorWorkerResponse = { sequence: number; snapshot?: MonitorWorkerSnapshot; processChunk?: MonitorProcessChunk; queryResult?: MonitorWorkerQueryResult }
