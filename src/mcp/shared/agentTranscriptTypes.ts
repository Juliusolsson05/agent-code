export type AgentTranscriptProvider = 'claude' | 'codex'
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
    }
  | {
      kind: 'patch'
      timestamp?: number
      files: string[]
      summary?: string
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
