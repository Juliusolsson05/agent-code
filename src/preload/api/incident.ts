import { flushPreloadMonitoring } from '../monitorOperations.js'
import { parseMonitorRendererRecord } from '@shared/performance/monitorContracts.js'
import { ipcRenderer } from 'electron'

import type { RendererFreezeHeartbeat } from '@shared/incident/rendererFreeze.js'

// Renderer -> main incident breadcrumbs.
//
// One-way, fire-and-forget (`send`, not `invoke`): renderer errors are
// diagnostics, never the source of truth for main/process health, so we never
// block the renderer waiting on a reply. Rate-limiting and redaction happen at
// the call site in the renderer BEFORE this is invoked (see app/main.tsx) — the
// preload stays a thin pass-through.
export type RendererIncidentReport = {
  kind: 'renderer.error' | 'renderer.unhandledrejection' | 'renderer.bootstrap'
  message: string
  source?: string
  line?: number
  column?: number
  stack?: string
}

// One credit bounds Electron's transport queue even when main is blocked for
// minutes. Do not reset on a timeout: that would quietly admit an unbounded
// second queue behind a frozen main. A later ACK resumes the next heartbeat.
let heartbeatInFlight = false
ipcRenderer.on('incident:renderer-heartbeat-ack', () => { heartbeatInFlight = false })

export const incidentApi = {
  reportIncident: (report: RendererIncidentReport): void => {
    ipcRenderer.send('incident:renderer-report', report)
  },
  // WHY this is a one-way signal: waiting for an invoke reply would couple the renderer's liveness
  // probe to main IPC latency and could itself leave promises queued during a freeze. Main records
  // receipt time, so the payload never needs to claim that delivery succeeded.
  reportRendererHeartbeat: (heartbeat: RendererFreezeHeartbeat): void => {
    // WHY projection also happens in preload: main can redact after receipt, but Electron has
    // already cloned and queued the renderer object by then. Copying the fixed numeric schema here
    // prevents accidental/compromised renderer fields from turning the liveness channel into an
    // unbounded content transport before main gets a chance to validate it.
    flushPreloadMonitoring()
    if (heartbeatInFlight) return
    const parsed = parseMonitorRendererRecord({
      kind: 'heartbeat', monotonicMs: heartbeat.monotonicMs,
      timeOriginMs: heartbeat.timeOriginMs ?? Math.max(0, heartbeat.sentAt - heartbeat.monotonicMs),
      lagMs: heartbeat.eventLoopLagMs, visibility: heartbeat.visibilityState === 'visible' ? 'visible' : 'hidden',
      longTaskCount: heartbeat.longTasks.count, longTaskTotalMs: heartbeat.longTasks.totalMs,
      longTaskMaxMs: heartbeat.longTasks.maxMs, heapUsedBytes: heartbeat.heap?.usedBytes ?? null,
      heapLimitBytes: heartbeat.heap?.limitBytes ?? null,
      inputCount: heartbeat.input?.count ?? 0, inputMaxMs: heartbeat.input?.maxMs ?? 0,
    })
    if (parsed?.kind !== 'heartbeat' || typeof heartbeat.sentAt !== 'number' || !Number.isFinite(heartbeat.sentAt)
      || heartbeat.sentAt < 0 || heartbeat.sentAt > Number.MAX_SAFE_INTEGER
      || (heartbeat.heap && (!Number.isFinite(heartbeat.heap.totalBytes)
        || typeof heartbeat.heap.totalBytes !== 'number' || heartbeat.heap.totalBytes < 0
        || heartbeat.heap.totalBytes > Number.MAX_SAFE_INTEGER))) return
    heartbeatInFlight = true
    ipcRenderer.send('incident:renderer-heartbeat', {
      sentAt: heartbeat.sentAt,
      monotonicMs: parsed.monotonicMs,
      timeOriginMs: parsed.timeOriginMs,
      longTasksSupported: heartbeat.longTasksSupported === true,
      inputSupported: heartbeat.inputSupported === true,
      input: { count: parsed.inputCount, maxMs: parsed.inputMaxMs },
      eventLoopLagMs: parsed.lagMs,
      visibilityState: parsed.visibility,
      longTasks: {
        count: parsed.longTaskCount,
        totalMs: parsed.longTaskTotalMs,
        maxMs: parsed.longTaskMaxMs,
      },
      ...(heartbeat.heap === undefined ? {} : { heap: { usedBytes: heartbeat.heap.usedBytes, totalBytes: heartbeat.heap.totalBytes, limitBytes: heartbeat.heap.limitBytes } }),
    } satisfies RendererFreezeHeartbeat)
  },
}
