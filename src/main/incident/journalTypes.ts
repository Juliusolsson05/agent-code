export type AppRunJournalSeverity = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export type AppRunJournalIds = {
  sessionId?: string
  providerSessionId?: string
  orchestrationRunId?: string
  orchestrationRequestId?: string
  mcpSessionId?: string
  workspaceSaveSeq?: number
}

export type AppRunJournalEventInput = {
  area: string
  name: string
  severity?: AppRunJournalSeverity
  ids?: AppRunJournalIds
  data?: Record<string, unknown>
}

export type AppRunJournalEvent = AppRunJournalEventInput & {
  schemaVersion: 1
  seq: number
  ts: number
  tsIso: string
  monotonicMs: number
  appRunId: string
  severity: AppRunJournalSeverity
}

export type AppRunJournalManifest = {
  schemaVersion: 1
  appRunId: string
  startedAt: number
  startedAtIso: string
  pid: number
  platform: NodeJS.Platform
  arch: string
  node: string
  electron: string | undefined
  chrome: string | undefined
  appVersion: string
  stateDir: string
  perfEnabled: boolean
  lock: {
    // WHY only the path, never the lock token: this manifest is an always-on,
    // retained-for-50-runs forensic file. The process-lock token is the secret
    // that gates lock REMOVAL (processLock compares it before deleting the
    // lock), so persisting it in cleartext would leak a security-relevant
    // credential to disk. The path is enough to correlate which lock this run
    // held; the token stays in memory only.
    path: string
  }
}

// Incidents are higher-level failure facts (vs. events, which are routine
// lifecycle breadcrumbs). An incident is something expected to matter AFTER a
// restart: a crash, a freeze, a child-process death. They live in their own
// incidents.jsonl so a triage scan never has to wade through the event stream.
export type AppRunIncidentSeverity = 'warn' | 'error' | 'fatal'

export type AppRunIncidentKind =
  | 'app.prior_unclean_shutdown'
  | 'app.startup_failed'
  | 'main.uncaught_exception'
  | 'main.unhandled_rejection'
  | 'main.warning'
  | 'window.render_process_gone'
  | 'window.unresponsive'
  | 'window.responsive'
  | 'window.preload_error'
  | 'window.did_fail_load'
  | 'electron.child_process_gone'
  | 'heap.pressure'
  | 'renderer.error'
  | 'renderer.unhandledrejection'
  | 'session.input_write_failed'
  | 'orchestration.request_timeout'
  | 'orchestration.prompt_delivery_failed'
  | 'mcp.host_start_failed'

export type AppRunIncidentInput = {
  kind: AppRunIncidentKind
  severity: AppRunIncidentSeverity
  process?: 'main' | 'renderer' | 'gpu' | 'utility' | 'child'
  reason?: string
  exitCode?: number
  // Raw error from a hook; normalized to {name,message,stack} before persistence.
  error?: unknown
  context?: Record<string, unknown>
}

export type AppRunIncident = {
  schemaVersion: 1
  incidentId: string
  appRunId: string
  seq: number
  ts: number
  tsIso: string
  kind: AppRunIncidentKind
  severity: AppRunIncidentSeverity
  process?: 'main' | 'renderer' | 'gpu' | 'utility' | 'child'
  reason?: string
  exitCode?: number
  error?: { name?: string; message: string; stack?: string }
  context?: Record<string, unknown>
}

export type AppRunHeartbeat = {
  schemaVersion: 1
  appRunId: string
  seq: number
  ts: number
  tsIso: string
  uptimeMs: number
  pid: number
  memory: {
    rss: number
    heapUsed: number
    heapTotal: number
    heapLimit: number
    external: number
    arrayBuffers: number
  }
  mainEventLoop: {
    delayMeanMs: number
    delayMaxMs: number
    delayP99Ms: number
  }
  window: {
    count: number
    focused: boolean
  }
  lastEventSeq: number
}
