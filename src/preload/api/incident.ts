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

export const incidentApi = {
  reportIncident: (report: RendererIncidentReport): void => {
    ipcRenderer.send('incident:renderer-report', report)
  },
  // WHY this is a one-way signal: waiting for an invoke reply would couple the renderer's liveness
  // probe to main IPC latency and could itself leave promises queued during a freeze. Main records
  // receipt time, so the payload never needs to claim that delivery succeeded.
  reportRendererHeartbeat: (heartbeat: RendererFreezeHeartbeat): void => {
    ipcRenderer.send('incident:renderer-heartbeat', heartbeat)
  },
}
