import { BoundedQueue } from '@shared/performance/boundedQueue.js'
import { MONITOR_POLICY } from '@shared/performance/monitorPolicy.js'
import { OperationTimers } from '@shared/performance/operationTimers.js'
import { MONITOR_RECORD_BYTES } from '@shared/performance/monitorContracts.js'
import type { MonitorRendererRecord } from '@shared/performance/monitorContracts.js'
import { subscribeRendererProbe } from './freezeHeartbeat'

const queue = new BoundedQueue<MonitorRendererRecord>(2000, MONITOR_POLICY.sourceQueueBytes)
export const rendererOperations = new OperationTimers(record => queue.push(record, MONITOR_RECORD_BYTES))
let pending = false
let transportLost = 0
let reportedDropped = 0
const unsubscribe = subscribeRendererProbe(() => {
  rendererOperations.sweep()
  const dropped = queue.stats.dropped + rendererOperations.dropped + transportLost
  if (pending || (!queue.stats.records && dropped === reportedDropped)) return
  const reportLoss = dropped !== reportedDropped
  const records = queue.drain(reportLoss ? 119 : 120, (reportLoss ? 119 : 120) * MONITOR_RECORD_BYTES)
  if (reportLoss) records.push({ kind: 'loss', source: 'renderer', dropped })
  const observations = records.filter(record => record.kind !== 'loss').length
  pending = true
  void window.api.appendMonitorRecords(records).then(ok => {
    if (ok && reportLoss) reportedDropped = dropped
    else if (!ok) transportLost += observations
  }, () => { transportLost += observations }).finally(() => { pending = false })
})
if (import.meta.hot) import.meta.hot.dispose(() => { unsubscribe(); queue.clear() })
