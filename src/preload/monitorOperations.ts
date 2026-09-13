import { ipcRenderer } from 'electron'
import { BoundedQueue } from '@shared/performance/boundedQueue.js'
import { OperationTimers } from '@shared/performance/operationTimers.js'
import type { OperationEnd } from '@shared/performance/operationTimers.js'
import { MONITOR_RECORD_BYTES } from '@shared/performance/monitorContracts.js'
import type { MonitorRendererRecord } from '@shared/performance/monitorContracts.js'
import { isMonitorId } from '@shared/performance/monitorContracts.js'

const records = new BoundedQueue<MonitorRendererRecord>(2000, 512 * 1024)
const timers = new OperationTimers(record => records.push(record, MONITOR_RECORD_BYTES))
const responses = new Map<string, { end: OperationEnd; at: number }>()
const invoke = ipcRenderer.invoke.bind(ipcRenderer)
let installed = false
let pending = false
let transportLost = 0
let reportedDropped = 0

export function installMonitorInvokes(): void {
  if (installed) return
  installed = true
  ipcRenderer.invoke = (channel, ...args) => {
    // Exclude the diagnostic transport to prevent measurement recursion. Only
    // the fixed metric name survives this wrapper; channel/arguments never do.
    if (channel.startsWith('performance:') || channel.startsWith('incident:') || channel.startsWith('lifecycle:')) return invoke(channel, ...args)
    const end = timers.begin('ipc.round-trip')
    return invoke(channel, ...args).then(result => {
      end()
      return result
    }, error => {
      end('error')
      throw error
    })
  }
}

export function beginMonitorResponse(sessionId: string, operationId?: string): void {
  if (!isMonitorId(sessionId)) return
  const end = timers.begin('renderer.first-output', sessionId, isMonitorId(operationId) ? operationId : undefined)
  responses.get(sessionId)?.end('cancelled')
  if (responses.size < 2048) responses.set(sessionId, { end, at: performance.now() })
  else end('cancelled')
  // Instrumentation is observational. A closing/reloading renderer can reject
  // IPC synchronously, but that must never turn Enter into a failed submit.
  try { ipcRenderer.send('performance:monitor-response-begin', sessionId, operationId) }
  catch { /* Main will simply lack this optional correlation boundary. */ }
}

export function cancelMonitorResponse(sessionId: string): void {
  if (!isMonitorId(sessionId)) return
  responses.get(sessionId)?.end('cancelled')
  responses.delete(sessionId)
  try { ipcRenderer.send('performance:monitor-response-cancel', sessionId) }
  catch { /* Cancellation still removed the bounded local timer above. */ }
}

export function completeMonitorResponse(sessionId: string): void {
  if (!isMonitorId(sessionId)) return
  responses.get(sessionId)?.end()
  responses.delete(sessionId)
}

export function flushPreloadMonitoring(): void {
  timers.sweep()
  for (const [id, response] of responses) if (performance.now() - response.at >= 10 * 60_000) { response.end('timeout'); responses.delete(id) }
  const dropped = records.stats.dropped + timers.dropped + transportLost
  if (pending || (!records.stats.records && dropped === reportedDropped)) return
  const reportLoss = dropped !== reportedDropped
  const batch = records.drain(reportLoss ? 119 : 120, (reportLoss ? 119 : 120) * MONITOR_RECORD_BYTES)
  if (reportLoss) batch.push({ kind: 'loss', source: 'preload', dropped })
  const observations = batch.filter(record => record.kind !== 'loss').length
  pending = true
  void invoke('performance:monitor-batch', batch).then(() => { if (reportLoss) reportedDropped = dropped }, () => {
    // Drained observations cannot be retried without an unbounded replay lane.
    // Account them in the next monotonic health report instead.
    transportLost += observations
  }).finally(() => { pending = false })
}
