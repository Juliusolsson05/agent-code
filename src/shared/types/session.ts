// Base session types that all providers implement. The shell and main
// process only interact with sessions through these types — never
// through provider-specific session classes directly.
//
// Why these live in shared/ instead of in each provider:
//   The shell (workspaceStore, sessionManager, IPC handlers) needs to
//   talk about sessions generically. These types are the contract.
//   Provider-specific session classes implement/extend them.

export type SessionOptions = {
  cwd: string
  cols?: number
  rows?: number
  binary?: string
  env?: Record<string, string | undefined>
  snapshotIntervalMs?: number
  resumeSessionId?: string
}

export type SessionInfo = {
  sessionId: string
  summary: string
  lastModified: number
  fileSize: number
  customTitle?: string
  firstPrompt?: string
  gitBranch?: string
  cwd?: string
  createdAt?: number
}
