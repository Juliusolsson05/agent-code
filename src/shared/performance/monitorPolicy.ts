// Baseline monitoring has a separate policy from AGENT_CODE_PERF. The legacy
// flag enables arbitrary diagnostic spans; enabling that pipeline for every
// installation would also enable its expensive serializers and observers.
// These limits apply before transport/retention, including a stalled consumer.
export const MONITOR_POLICY = Object.freeze({
  schemaVersion: 1 as const,
  sourceQueueBytes: 512 * 1024,
  sourceQueueRecords: 2_000,
  coordinatorQueueBytes: 2 * 1024 * 1024,
  batchBytes: 64 * 1024,
  queryBytes: 256 * 1024,
  // Reserve framing bytes as well as the conservative per-record charge.
  rendererBatchRecords: 120,
  processLimit: 2_048,
  windowLimit: 64,
  seriesPoints: 1_000,
  // Worst-case legal point widths plus 50 incident summaries stay below the
  // 256 KiB cross-process query ceiling at this chart-page size.
  historyPagePoints: 300,
  historyBytes: 128 * 1024 * 1024,
  incidentReserveBytes: 8 * 1024 * 1024,
  incidentBytes: 1024 * 1024,
  incidentCount: 50,
  traceBytes: 64 * 1024 * 1024,
  heartbeatMs: 1_000,
  sampleMs: 5_000,
  topologyMs: 15_000,
  recentMs: 15 * 60_000,
  historyMs: 7 * 24 * 60 * 60_000,
  profileMs: 30_000,
  maxProfileMs: 60_000,
})

// A finite vocabulary prevents accidental prompt/path retention and unbounded
// metric cardinality. Add a name only with a real boundary and a documented
// unit. Dynamic session IDs belong in a bounded identity field, never a name.
export const MONITOR_OPERATIONS = [
  'app.startup',
  'session.spawn',
  'session.ready',
  'prompt.delivery',
  'provider.first-output',
  'renderer.first-output',
  'ipc.round-trip',
  'ipc.handler',
  'transcript.read',
  'transcript.parse',
  'transcript.fold',
  'transcript.commit',
  'terminal.write',
  'worktree.refresh',
  'persistence.serialize',
  'persistence.write',
  'orchestration.queue',
  'orchestration.dispatch',
  'dictation.capture',
  'dictation.provider',
  'profile.chromium',
  'profile.main-cpu',
  'heap.snapshot',
] as const

export type MonitorOperationName = typeof MONITOR_OPERATIONS[number]
export type MonitorOutcome = 'success' | 'error' | 'cancelled' | 'timeout'
export type MonitorQuality = 'ok' | 'warming-up' | 'stale' | 'unsupported' | 'partial'
