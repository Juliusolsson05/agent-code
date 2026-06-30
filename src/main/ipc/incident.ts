import { ipcMain } from 'electron'

import type { AppRunJournal } from '@main/incident/AppRunJournal.js'

// Bridges renderer-reported breadcrumbs into the always-on incident journal.
//
// WHY renderer reports are enrichment, not truth: the renderer cannot report
// its own crash once it's gone, so main's own window hooks (render-process-gone,
// unresponsive, preload-error) remain the source of truth for renderer death.
// These reports add the JS-level detail main can't see — a caught exception, an
// unhandled rejection, a React boundary trip — as non-fatal incidents.
//
// Defensive parsing: the payload crosses an IPC boundary from a process that may
// itself be misbehaving, so we validate every field and never trust the shape.

const ALLOWED_KINDS = new Set<string>([
  'renderer.error',
  'renderer.unhandledrejection',
  'renderer.bootstrap',
])

export function registerIncidentIpc(journal: AppRunJournal): void {
  ipcMain.on('incident:renderer-report', (_event, report: unknown) => {
    if (!report || typeof report !== 'object') return
    const r = report as Record<string, unknown>
    const kind = typeof r.kind === 'string' ? r.kind : ''
    if (!ALLOWED_KINDS.has(kind)) return
    const message = typeof r.message === 'string' ? r.message.slice(0, 500) : ''

    // Bootstrap milestones are routine lifecycle events, not failures.
    if (kind === 'renderer.bootstrap') {
      journal.record({
        area: 'renderer.bootstrap',
        name: message || 'renderer.bootstrap',
        severity: 'info',
        data: { source: typeof r.source === 'string' ? r.source : null },
      })
      return
    }

    journal.recordIncident({
      kind: kind as 'renderer.error' | 'renderer.unhandledrejection',
      severity: 'warn',
      process: 'renderer',
      reason: message,
      context: {
        source: typeof r.source === 'string' ? r.source : null,
        line: typeof r.line === 'number' ? r.line : null,
        column: typeof r.column === 'number' ? r.column : null,
        stack: typeof r.stack === 'string' ? r.stack : null,
      },
    })
  })
}
