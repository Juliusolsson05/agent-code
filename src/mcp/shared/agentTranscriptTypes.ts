import type { AgentProviderKind } from '@shared/types/providerKind.js'

// Alias of the single provider source of truth (#394 phase 1). 'auto'
// stays a transcript-tool concept (content-sniff the provider), not a
// provider kind.
export type AgentTranscriptProvider = AgentProviderKind
export type AgentTranscriptProviderInput = AgentTranscriptProvider | 'auto'

export type AgentTranscriptProjection =
  | 'final'
  | 'assistant_messages'
  | 'conversation'
  | 'tool_reads'
  | 'tool_writes'
  | 'shell_commands'
  | 'file_changes'
  | 'tests'
  | 'timeline'
  | 'handoff'

export const AGENT_TRANSCRIPT_PROJECTIONS: readonly AgentTranscriptProjection[] = [
  'final',
  'assistant_messages',
  'conversation',
  'tool_reads',
  'tool_writes',
  'shell_commands',
  'file_changes',
  'tests',
  'timeline',
  'handoff',
] as const

export type AgentTranscriptItemKind =
  | 'user_message'
  | 'assistant_message'
  | 'tool_read'
  | 'tool_write'
  | 'shell_command'
  | 'patch'
  | 'test_run'

export const AGENT_TRANSCRIPT_ITEM_KINDS: readonly AgentTranscriptItemKind[] = [
  'user_message',
  'assistant_message',
  'tool_read',
  'tool_write',
  'shell_command',
  'patch',
  'test_run',
] as const

export type AgentTranscriptItem =
  | {
      kind: 'user_message'
      timestamp?: number
      text: string
    }
  | {
      kind: 'assistant_message'
      timestamp?: number
      text: string
      final?: boolean
    }
  | {
      kind: 'tool_read'
      timestamp?: number
      tool: string
      target?: string
      excerpt?: string
    }
  | {
      kind: 'tool_write'
      timestamp?: number
      tool: string
      target?: string
      summary?: string
    }
  | {
      kind: 'shell_command'
      timestamp?: number
      cwd?: string
      command: string
      exitCode?: number
      outputExcerpt?: string
      /** Present only when the command was READ FROM SCRIPT SOURCE rather
       *  than recorded as run: Codex code-mode `exec` scripts (#1362).
       *  `'unknown'` means the script contains this call, but nothing in
       *  the transcript proves it executed. A call in a branch that never
       *  ran looks exactly like one that did, and Codex's combined script
       *  output does not say which. Absent means the provider recorded the
       *  command itself (the default for every other source). Steering q86:
       *  a reader must never present an unexecuted branch as a command that
       *  ran, so the uncertainty travels on the entry, not only in the tool
       *  description. */
      executed?: 'unknown'
    }
  | {
      kind: 'patch'
      timestamp?: number
      files: string[]
      summary?: string
      /** As on `shell_command`: the patch call was read from script source
       *  and is not proven to have run. */
      executed?: 'unknown'
    }
  | {
      kind: 'test_run'
      timestamp?: number
      command: string
      result: 'pass' | 'fail' | 'unknown'
      outputExcerpt?: string
    }

export type AgentTranscriptIncludeOptions = {
  userMessages?: boolean
  assistantMessages?: boolean
  toolReads?: boolean
  toolWrites?: boolean
  shellCommands?: boolean
  patches?: boolean
  testRuns?: boolean
  rawToolOutputs?: boolean
}

export type AgentTranscriptStats = {
  totalEvents: number
  returnedItems: number
  userMessages: number
  assistantMessages: number
  toolReads: number
  toolWrites: number
  shellCommands: number
  patches: number
  testRuns: number
  parseErrors: number
}

export type AgentTranscriptReadResult = {
  ok: true
  path: string
  provider: AgentTranscriptProvider
  projection: AgentTranscriptProjection
  items: AgentTranscriptItem[]
  truncated: boolean
  stats: AgentTranscriptStats
}

export type AgentTranscriptInspectResult = {
  ok: true
  path: string
  provider: AgentTranscriptProvider
  firstTimestamp?: number
  lastTimestamp?: number
  stats: AgentTranscriptStats
}

export type AgentTranscriptSearchResult = {
  ok: true
  path: string
  provider: AgentTranscriptProvider
  query: string
  matches: Array<{
    item: AgentTranscriptItem
    before?: AgentTranscriptItem[]
    after?: AgentTranscriptItem[]
  }>
  truncated: boolean
  stats: AgentTranscriptStats
}

export type AgentTranscriptErrorResult = {
  ok: false
  error:
    | 'path_required'
    | 'file_not_found'
    | 'file_not_readable'
    | 'provider_detection_failed'
    | 'unsupported_provider'
    | 'transcript_read_failed'
  message: string
}
