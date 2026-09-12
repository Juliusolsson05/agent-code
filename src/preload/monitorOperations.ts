import { ipcRenderer } from 'electron'
import { BoundedQueue } from '@shared/performance/boundedQueue.js'
import { OperationTimers } from '@shared/performance/operationTimers.js'
import type { OperationEnd } from '@shared/performance/operationTimers.js'
import type { MonitorRendererRecord } from '@shared/performance/monitorContracts.js'
import { isMonitorId } from '@shared/performance/monitorContracts.js'

const records = new BoundedQueue<MonitorRendererRecord>(2000, 512 * 1024)
const timers = new OperationTimers(record => records.push(record, 512))
const responses = new Map<string, { end: OperationEnd; at: number }>()
const invoke = ipcRenderer.invoke.bind(ipcRenderer)
let installed = false
let pending = false

export function installMonitorInvokes(): void {
  if (installed) return
  installed = true
  ipcRenderer.invoke = (channel, ...args) => {
    // Exclude the diagnostic transport to prevent measurement recursion. Only
    // the fixed metric name survives this wrapper; channel/arguments never do.
    if (channel.startsWith('performance:') || channel.startsWith('incident:') || channel.startsWith('lifecycle:')) return invoke(channel, ...args)
    const end = timers.begin('ipc.round-trip')
    const sessionId = channel === 'session:deliver-prompt' && isMonitorId(args[0]) ? args[0] : null
    const response = sessionId ? timers.begin('renderer.first-output', sessionId, isMonitorId(args[3]) ? args[3] : undefined) : null
    if (sessionId && response) {
      responses.get(sessionId)?.end('cancelled')
      if (responses.size < 2048) responses.set(sessionId, { end: response, at: performance.now() })
      else response('cancelled')
    }
    return invoke(channel, ...args).then(result => {
      end()
      if (sessionId && response && result?.ok === false) {
        response('error')
        responses.delete(sessionId)
      }
      return result
    }, error => {
      end('error')
      response?.('error')
      if (sessionId) responses.delete(sessionId)
      throw error
    })
  }
}

export function completeMonitorResponse(sessionId: string): void {
  if (!isMonitorId(sessionId)) return
  responses.get(sessionId)?.end()
  responses.delete(sessionId)
}

export function flushPreloadMonitoring(): void {
  timers.sweep()
  for (const [id, response] of responses) if (performance.now() - response.at >= 10 * 60_000) { response.end('timeout'); responses.delete(id) }
  if (pending || !records.stats.records) return
  const batch = records.drain(120, 63 * 1024)
  pending = true
  void invoke('performance:monitor-batch', batch).catch(() => {}).finally(() => { pending = false })
}
