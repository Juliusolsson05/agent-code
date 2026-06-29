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
