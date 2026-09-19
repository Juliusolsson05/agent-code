import { BoundedQueue } from '@shared/performance/boundedQueue.js'
import { MONITOR_POLICY } from '@shared/performance/monitorPolicy.js'
import { OperationTimers } from '@shared/performance/operationTimers.js'
import { MONITOR_RECORD_BYTES } from '@shared/performance/monitorContracts.js'
import type { MonitorRendererRecord } from '@shared/performance/monitorContracts.js'
import { subscribeRendererProbe } from './freezeHeartbeat'

const BATCH_RECORDS = MONITOR_POLICY.rendererBatchRecords
const queue = new BoundedQueue<MonitorRendererRecord>(2000, MONITOR_POLICY.sourceQueueBytes)
export const rendererOperations = new OperationTimers(record => {
  queue.push(record, MONITOR_RECORD_BYTES)
  // The heartbeat alone drains 120 records per second. A commit storm can
  // exceed that many times over, so a full batch flushes immediately instead
  // of being counted as loss when the bounded queue overflows.
  if (queue.stats.records >= BATCH_RECORDS) scheduleFlush()
})
let pending = false
let flushScheduled = false
let transportLost = 0
let reportedDropped = 0
let lastFlushAt = -Infinity
// One opaque ID per renderer lifetime; a reload gets a new one (see preload).
const producerGeneration = globalThis.crypto.randomUUID()

function scheduleFlush(): void {
  if (flushScheduled || pending) return
  flushScheduled = true
  // At most one threshold batch per 100 ms (1,200 records/s per producer).
  // Unthrottled flushing only moved overflow from this queue into main's
  // shared queue, where it evicted heartbeats instead of operations.
  setTimeout(() => { flushScheduled = false; flush() }, Math.max(0, lastFlushAt + 100 - performance.now()))
}

function flush(): void {
  rendererOperations.sweep()
  const dropped = queue.stats.dropped + rendererOperations.dropped + transportLost
  if (pending || (!queue.stats.records && dropped === reportedDropped)) return
  const append = window.api?.appendMonitorRecords
  if (!append) return
  const reportLoss = dropped !== reportedDropped
  const size = reportLoss ? BATCH_RECORDS - 1 : BATCH_RECORDS
  const records = queue.drain(size, size * MONITOR_RECORD_BYTES)
  if (reportLoss) records.push({ kind: 'loss', source: 'renderer', generation: producerGeneration, dropped })
  const observations = records.filter(record => record.kind !== 'loss').length
  pending = true
  lastFlushAt = performance.now()
  void append(records).then(ok => {
    if (ok && reportLoss) reportedDropped = dropped
    else if (!ok) transportLost += observations
  }, () => { transportLost += observations }).finally(() => {
    pending = false
    if (queue.stats.records >= BATCH_RECORDS) scheduleFlush()
  })
}

const unsubscribe = subscribeRendererProbe(flush)
if (import.meta.hot) import.meta.hot.dispose(() => { unsubscribe(); queue.clear() })
