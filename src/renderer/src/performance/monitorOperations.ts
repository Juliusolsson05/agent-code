import { BoundedQueue } from '@shared/performance/boundedQueue.js'
import { MONITOR_POLICY } from '@shared/performance/monitorPolicy.js'
import { OperationTimers } from '@shared/performance/operationTimers.js'
import type { MonitorRendererRecord } from '@shared/performance/monitorContracts.js'
import { subscribeRendererProbe } from './freezeHeartbeat'

const queue = new BoundedQueue<MonitorRendererRecord>(2000, MONITOR_POLICY.sourceQueueBytes)
export const rendererOperations = new OperationTimers(record => queue.push(record, 512))
let pending = false
const unsubscribe = subscribeRendererProbe(() => {
  rendererOperations.sweep()
  if (pending || !queue.stats.records) return
  const records = queue.drain(120, MONITOR_POLICY.batchBytes - 1024)
  pending = true
  void window.api.appendMonitorRecords(records).catch(() => false).finally(() => { pending = false })
})
if (import.meta.hot) import.meta.hot.dispose(() => { unsubscribe(); queue.clear() })
