import type { BuiltInMcpServerConfig } from '@mcp/shared/types.js'

// Re-export the provider/session kind source of truth so callers that
// already import session types from here keep one import. The canonical
// definition (and the rationale for the AgentProviderKind vs SessionKind
// split) lives in providerKind.ts — see that file before adding a kind.
export type { AgentProviderKind, SessionKind } from '@shared/types/providerKind.js'

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
  /** Stable Agent Code session id assigned by SessionManager. Provider
   *  runtimes can use this for app-owned artifact storage paths
   *  without coupling themselves to the manager implementation. */
  shellSessionId?: string
  /** Opt-in mitmproxy-backed transport capture. Currently only the
   *  Claude provider honors this — Codex ignores it. Declared here
   *  (rather than cast inline at the spawn site) so the contract is
   *  visible to every provider and TypeScript doesn't silently lose
   *  the field the next time the spawn shape changes. */
  useProxy?: boolean
  /** Per-process MCP server configs minted by main for built-in Agent Code
   *  domains. Providers only receive concrete launch material (URL + headers),
   *  never the long-lived domain policy; the renderer/session metadata remains
   *  the source of truth for which domains should be enabled. */
  builtInMcpServers?: BuiltInMcpServerConfig[]
}

export type SessionInfo = {
  /**
   * WHY this shared type is the source of truth:
   * preload, renderer resume UI, provider listers, and main registries all pass
   * these records across process/module boundaries. Local copies drift silently
   * because most fields are optional and UI call sites usually touch only one or
   * two of them. Keep new metadata here first, then let provider-specific
   * listers populate the same contract instead of redefining compatible-looking
   * shadows.
   */
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
