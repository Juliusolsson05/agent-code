import type { AgentProviderKind } from './providerKind.js'

// This is the serializable subset of agent-transcript-parser's PromptAddress
// that crosses Electron IPC. The durable coordinate is provider + source line
// + source session, with a native UUID as an optional stronger check. Keeping
// the address independent of renderer feed rows is load-bearing: renderers are
// allowed to hide metadata and duplicate event planes, so their list indexes
// can never identify an exact record in the source transcript.
export type RewindPromptAddress = {
  provider: AgentProviderKind
  line: number
  sessionId: string | null
  uuid?: string | null
}

export type RewindPrompt = {
  address: RewindPromptAddress
  text: string
  timestamp: string | null
}

export type ListRewindPromptsRequest = {
  provider: AgentProviderKind
  sourceProviderSessionId: string
  cwd: string
  limit?: number
}

