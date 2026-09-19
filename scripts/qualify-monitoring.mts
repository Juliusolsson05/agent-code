import { performance } from 'node:perf_hooks'
import { arch, platform } from 'node:os'
import { BoundedQueue } from '../src/shared/performance/boundedQueue.ts'
import { MONITOR_RECORD_BYTES } from '../src/shared/performance/monitorContracts.ts'
import { MONITOR_POLICY } from '../src/shared/performance/monitorPolicy.ts'
import { OperationTimers } from '../src/shared/performance/operationTimers.ts'
import type { MonitorHistoryPoint } from '../src/shared/performance/monitorHistory.ts'

// This is the fast deterministic half of rollout qualification. It turns ten
// minutes of maximum-fleet transport and 24 hours of retention growth into a
// few seconds without pretending that simulated time proves packaged CPU/RSS.
// The real 8 h/24 h runner uses the same JSON fields so evidence can be compared.
const normal = new BoundedQueue<number>(1600, 1600 * MONITOR_RECORD_BYTES)
const processes = new BoundedQueue<{ generation: number; end: boolean }>(2306, 2306 * MONITOR_RECORD_BYTES)
let generation = 0
let completed = 0
let maxQueuedBytes = 0
for (let tick = 0; tick < 10 * 60 * 5; tick++) {
  if (tick % 25 === 0 && processes.stats.records === 0) {
    generation++
    for (let row = 0; row < 2306; row++) processes.push({ generation, end: row === 2305 }, MONITOR_RECORD_BYTES)
  }
  // Deliberately exceed normal-path capacity. Process generations must still
  // finish because their reserved queue/credit cannot be consumed by an
  // operation or 64-window heartbeat storm.
  for (let record = 0; record < 213; record++) normal.push(record, MONITOR_RECORD_BYTES)
  const processBatch = processes.drain(100, 100 * MONITOR_RECORD_BYTES)
  const batch = [...processBatch, ...normal.drain(120 - processBatch.length, (120 - processBatch.length) * MONITOR_RECORD_BYTES)]
  if (batch.some(record => typeof record === 'object' && record.end)) completed++
  maxQueuedBytes = Math.max(maxQueuedBytes, normal.stats.bytes + processes.stats.bytes + batch.length * MONITOR_RECORD_BYTES)
}
if (processes.stats.dropped !== 0 || completed !== generation || maxQueuedBytes > 2 * 1024 * 1024) {
  throw new Error(`bounded transport qualification failed: ${JSON.stringify({ generation, completed, processDrops: processes.stats.dropped, maxQueuedBytes })}`)
}

const durations: number[] = []
const timers = new OperationTimers(() => {})
for (let index = 0; index < 100_000; index++) {
  const before = performance.now()
  timers.begin('ipc.handler')()
  durations.push((performance.now() - before) * 1000)
}
durations.sort((a, b) => a - b)

const representative: MonitorHistoryPoint = {
  schemaVersion: 1, at: Date.now(), resolution: '1m',
  main: { cpuPercent: 10, rss: 512 * 1024 * 1024, heapUsed: 128 * 1024 * 1024, heapLimit: 1024 * 1024 * 1024, loopP99Ms: 22, loopMaxMs: 48, sleepGap: false },
  processes: { cpuPercent: 140, memoryBytes: 2 * 1024 * 1024 * 1024, count: 100, sessionCount: 32, quality: 'ok' },
  windows: { count: 4, visible: 2, maxLagMs: 20, longTaskMs: 0, maxInputMs: 0 },
  workerRss: 64 * 1024 * 1024, droppedRecords: 0, restarts: 0,
}
const retainedPoints = 15 * 60 + 24 * 60 * 6 + 7 * 24 * 60
const projectedHistoryBytes = Buffer.byteLength(`${JSON.stringify(representative)}\n`) * retainedPoints
if (projectedHistoryBytes > 64 * 1024 * 1024) throw new Error('tiered history projection exceeds the compaction operating budget')

process.stdout.write(`${JSON.stringify({
  scope: 'deterministic transport, hook, and retention qualification; packaged soak still required',
  platform: platform(), arch: arch(), node: process.version,
  maxFleet: { simulatedMinutes: 10, generations: generation, completed, processDrops: processes.stats.dropped, normalDrops: normal.stats.dropped, maxQueuedBytes },
  hook: { iterations: durations.length, p99Us: durations[Math.floor(durations.length * 0.99)] },
  retention: { simulatedHours: 24, sevenDayTierPoints: retainedPoints, projectedHistoryBytes, automaticHardCapBytes: MONITOR_POLICY.historyBytes },
}, null, 2)}\n`)
