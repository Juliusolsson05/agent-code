import { ipcRenderer } from 'electron'

import type {
  SessionLifecycleCorrelationIds,
  SessionLifecycleData,
  SessionLifecycleEventName,
} from '@shared/lifecycle/events.js'

// Renderer -> main session-lifecycle breadcrumbs.
//
// One-way and fire-and-forget for the same reason as `incidentApi`: these are
// diagnostics, never product state, and every call site sits on a hot path
// (mount effects, submit handlers, the rehydrate loop). Nothing may wait on
// this, and nothing may branch on whether it succeeded.
//
// The preload stays a thin pass-through: name validation and payload
// allowlisting live in `@shared/lifecycle/events`, applied by the renderer
// helper before this is called and again by main after receipt. Duplicating
// that logic here would create a third copy that can drift.

export type SessionLifecycleReport = {
  name: SessionLifecycleEventName
  sessionId?: string
  data?: SessionLifecycleData
  correlationIds?: SessionLifecycleCorrelationIds
}

export const lifecycleApi = {
  reportSessionLifecycle: (report: SessionLifecycleReport): void => {
    ipcRenderer.send('session:lifecycle-report', report)
  },
}
