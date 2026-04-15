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
  dangerousMode?: boolean
  /** Stable cc-shell session id assigned by SessionManager. Provider
   *  runtimes can use this for app-owned artifact storage paths
   *  without coupling themselves to the manager implementation. */
  shellSessionId?: string
  /** Opt-in mitmproxy-backed transport capture. Currently only the
   *  Claude provider honors this — Codex ignores it. Declared here
   *  (rather than cast inline at the spawn site) so the contract is
   *  visible to every provider and TypeScript doesn't silently lose
   *  the field the next time the spawn shape changes. */
  useProxy?: boolean
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
