import { ipcRenderer } from 'electron'
import { BoundedQueue } from '@shared/performance/boundedQueue.js'
import { OperationTimers } from '@shared/performance/operationTimers.js'
import type { OperationEnd } from '@shared/performance/operationTimers.js'
import { MONITOR_RECORD_BYTES } from '@shared/performance/monitorContracts.js'
import type { MonitorRendererRecord } from '@shared/performance/monitorContracts.js'
import { isMonitorId } from '@shared/performance/monitorContracts.js'
import type { MonitorOutcome } from '@shared/performance/monitorPolicy.js'

const BATCH_RECORDS = 120
const records = new BoundedQueue<MonitorRendererRecord>(2000, 512 * 1024)
const timers = new OperationTimers(record => {
  records.push(record, MONITOR_RECORD_BYTES)
  // WHY flush on a threshold as well as the heartbeat: a burst (for example a
  // paste that fans out into hundreds of IPC round trips) fills 2,000 slots in
  // well under the one-second heartbeat, and everything beyond that became
  // "loss". Once a full batch is waiting there is no reason to hold it.
  if (records.stats.records >= BATCH_RECORDS) scheduleFlush()
})
type PendingResponse = { end: OperationEnd; at: number; operationId?: string; armed: boolean; outputAt: number | null }
const responses = new Map<string, PendingResponse>()
type Invoke = typeof ipcRenderer.invoke
let invoke: Invoke | undefined
let installed = false
let pending = false
let flushScheduled = false
let transportLost = 0
let reportedDropped = 0

function getOriginalInvoke(): Invoke | undefined {
  if (invoke) return invoke
  // WHY this is captured lazily: domain API modules import this helper before
  // the preload entrypoint installs the wrapper, and narrow test/fault harnesses
  // deliberately provide only the Electron methods that domain uses. Requiring
  // `invoke` while importing an unrelated one-way API makes the entire bridge
  // fail before monitoring can degrade harmlessly.
  if (typeof ipcRenderer.invoke !== 'function') return undefined
  invoke = ipcRenderer.invoke.bind(ipcRenderer)
  return invoke
}

export function installMonitorInvokes(): void {
  if (installed) return
  const originalInvoke = getOriginalInvoke()
  if (!originalInvoke) return
  installed = true
  ipcRenderer.invoke = (channel, ...args) => {
    // Exclude the diagnostic transport to prevent measurement recursion. Only
    // the fixed metric name survives this wrapper; channel/arguments never do.
    if (channel.startsWith('performance:') || channel.startsWith('incident:') || channel.startsWith('lifecycle:')) return originalInvoke(channel, ...args)
    const end = timers.begin('ipc.round-trip')
    return originalInvoke(channel, ...args).then(result => {
      end()
      return result
    }, error => {
      end('error')
      throw error
    })
  }
}

function finishResponse(sessionId: string, outcome: MonitorOutcome, endedAt?: number): void {
  const current = responses.get(sessionId)
  if (!current) return
  responses.delete(sessionId)
  current.end(outcome, endedAt)
}

/** Starts the renderer clock at Enter, unarmed. Nothing crosses IPC yet: only
 * the provider acceptance can say whether this submit starts a turn. */
export function beginMonitorResponse(sessionId: string, operationId?: string): void {
  if (!isMonitorId(sessionId)) return
  finishResponse(sessionId, 'cancelled')
  if (responses.size >= 2048) return
  const id = isMonitorId(operationId) ? operationId : undefined
  responses.set(sessionId, {
    end: timers.begin('renderer.first-output', sessionId, id), at: performance.now(),
    ...(id ? { operationId: id } : {}), armed: false, outputAt: null,
  })
}

/** Acceptance decides whether the unarmed clock measures anything. A queued
 * prompt waits behind a running turn, whose output would otherwise complete
 * this timer and record a response that belonged to a different prompt. */
export function acceptMonitorResponse(sessionId: string, queued: boolean): void {
  const current = responses.get(sessionId)
  if (!current) return
  if (queued) { finishResponse(sessionId, 'cancelled'); return }
  current.armed = true
  if (current.outputAt !== null) {
    // Output already committed while acceptance was pending. Main has seen
    // that output too, so asking it to begin now would time the NEXT turn.
    finishResponse(sessionId, 'success', current.outputAt)
    return
  }
  // Raw-PTY providers (Codex) never enter main's delivery path, so main starts
  // provider first-output here. Main-delivered prompts share the operation ID
  // and join the timer main already armed. Instrumentation is observational:
  // a closing renderer can reject IPC synchronously without failing submit.
  try { ipcRenderer.send('performance:monitor-response-begin', sessionId, current.operationId) }
  catch { /* Main will simply lack this optional correlation boundary. */ }
}

/** Local only, and only for a pending timer. Hidden tiles call this on every
 * output commit; the previous per-commit cancel IPC was main-process traffic
 * for a measurement main does not own. */
export function cancelMonitorResponse(sessionId: string): void {
  if (!isMonitorId(sessionId)) return
  finishResponse(sessionId, 'cancelled')
}

export function completeMonitorResponse(sessionId: string): void {
  if (!isMonitorId(sessionId)) return
  const current = responses.get(sessionId)
  if (!current) return
  if (current.armed) finishResponse(sessionId, 'success')
  else current.outputAt ??= performance.now()
}

function scheduleFlush(): void {
  if (flushScheduled || pending) return
  flushScheduled = true
  queueMicrotask(() => { flushScheduled = false; flushPreloadMonitoring() })
}

export function flushPreloadMonitoring(): void {
  timers.sweep()
  for (const [id, response] of responses) if (performance.now() - response.at >= 10 * 60_000) finishResponse(id, 'timeout')
  const dropped = records.stats.dropped + timers.dropped + transportLost
  if (pending || (!records.stats.records && dropped === reportedDropped)) return
  const originalInvoke = getOriginalInvoke()
  // Monitoring must remain optional during partial preload initialization and
  // fault isolation. Keeping the bounded batch in memory lets a later healthy
  // heartbeat retry without turning a missing diagnostic channel into an app
  // startup failure.
  if (!originalInvoke) return
  const reportLoss = dropped !== reportedDropped
  const size = reportLoss ? BATCH_RECORDS - 1 : BATCH_RECORDS
  const batch = records.drain(size, size * MONITOR_RECORD_BYTES)
  if (reportLoss) batch.push({ kind: 'loss', source: 'preload', dropped })
  const observations = batch.filter(record => record.kind !== 'loss').length
  pending = true
  void originalInvoke('performance:monitor-batch', batch).then(() => { if (reportLoss) reportedDropped = dropped }, () => {
    // Drained observations cannot be retried without an unbounded replay lane.
    // Account them in the next monotonic health report instead.
    transportLost += observations
  }).finally(() => {
    pending = false
    // Single-flight keeps IPC bounded; a backlog continues one batch at a time.
    if (records.stats.records >= BATCH_RECORDS) scheduleFlush()
  })
}
