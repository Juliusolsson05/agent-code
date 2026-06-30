import { ipcRenderer } from 'electron'

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
}
