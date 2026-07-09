import type { BuildInfo } from '@main/buildInfo.js'

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
  // DELIBERATELY still 1 after adding `build` + `classifierVersion` (#374).
  // The additions are purely additive: no existing field changed meaning or
  // shape, and every reader of this manifest is tolerant by construction —
  // previousRunClassifier.readPriorStartedAt() picks out `startedAt` and
  // ignores the rest, and debug bundles copy the file verbatim. A version bump
  // is reserved for changes that would make an OLD reader misinterpret a NEW
  // file (renames, semantic changes, removals); bumping on additive changes
  // would force every consumer to branch on version for zero safety gain, and
  // — worse — retained manifests from the previous 50 runs would suddenly look
  // "old-schema" to naive tooling.
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
  // Which exact SOURCE built the running bundle (#374). appVersion above is
  // not enough: in dev app.getVersion() reports Electron's own version, and
  // even in packaged builds a version string can't distinguish a dirty local
  // build from the tagged release. Injected at build time via the `define`
  // block in electron.vite.config.ts; see src/main/buildInfo.ts for per-field
  // semantics. All-'unknown' means the bundle ran without build injection
  // (vitest, or a broken define) — itself a useful triage signal.
  build: BuildInfo
  // PREVIOUS_RUN_CLASSIFIER_VERSION of the classifier COMPILED INTO this run.
  // Recorded in the manifest (not only on incidents) so triage can tell which
  // classifier will judge this run's death on the NEXT launch — the classifier
  // that examines this run's evidence is the next build's, and after an
  // upgrade those can differ.
  classifierVersion: number
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
  // Remote mobile companion (src/main/remote/) — declared here because this
  // union is the app-wide incident vocabulary; the remote subsystem imports
  // core, never the reverse (see the 2026-07-06 remote-companion spec's
  // isolation section).
  | 'remote.server_start_failed'

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
