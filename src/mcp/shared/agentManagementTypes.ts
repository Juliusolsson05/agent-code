import type { AgentProviderKind } from '@shared/types/providerKind.js'
import type { PromptDeliveryResult } from '@shared/types/providerConfig.js'

export type ManagedAgentPlacement = 'grid' | 'dispatch' | 'buried'

export type ManagedAgentBackendState =
  | 'live'
  | 'spawning'
  | 'hibernated'
  | 'failed'

export type ManagedAgentActivityState =
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'unknown'

export type ManagedAgentTranscriptAvailability =
  | 'available'
  | 'not_created'
  | 'provider_managed'
  | 'unavailable'

export type ManagedAgentProject = {
  tabId: string
  title: string
  index: number
}

export type ManagedAgentRecord = {
  sessionId: string
  kind: AgentProviderKind
  cwd: string
  title?: string
  project: ManagedAgentProject
  placement: ManagedAgentPlacement
  backendState: ManagedAgentBackendState
  activityState: ManagedAgentActivityState
  statusSummary?: string
  transcript: {
    path: string | null
    availability: ManagedAgentTranscriptAvailability
    lastModifiedAt?: number
  }
  lastActivityAt?: number
  lastActivitySource?: 'transcript' | 'runtime' | 'backend'
  idleForMs?: number
  processActive: boolean
  awaitingAssistant: boolean
  requiresUserAction: boolean
  conditionSummary?: string
  isCaller: boolean
  linkedParentId?: string
  orchestrationParentId?: string
  orchestrationRootId?: string
  orchestrationRunId?: string
  orchestrationRole?: string
}

export type ManagedAgentMessage = {
  role: 'user' | 'assistant'
  text: string
  timestamp?: string
  truncated?: boolean
  totalChars?: number
}

export type ManagedAgentTranscriptOutput = {
  agent: ManagedAgentRecord
  messages: ManagedAgentMessage[]
  latestAssistantText?: string
  truncated?: boolean
  totalChars?: number
}

/**
 * Renderer-private identity needed to resolve a parked session's canonical
 * provider transcript. The MCP response never exposes providerSessionId: the
 * useful audit handle is the resolved path, while provider identity is an
 * implementation detail that can be provisional or provider-specific.
 */
export type ManagedAgentRendererDescriptor = {
  agent: ManagedAgentRecord
  providerSessionId?: string
  transcriptActivityAt?: number
  runtimeActivityAt?: number
}

export type ManagedAgentRendererOutput = {
  output: ManagedAgentTranscriptOutput
  providerSessionId?: string
  transcriptActivityAt?: number
  runtimeActivityAt?: number
}

type AgentManagementRequestBase = {
  requestId: string
  callerSessionId: string
}

export type AgentManagementRendererRequest =
  | (AgentManagementRequestBase & { type: 'list-agents' })
  | (AgentManagementRequestBase & {
      type: 'read-agent'
      sessionId: string
      maxMessages?: number
      maxCharsPerMessage?: number
      maxCharsPerAgent?: number
    })
  | (AgentManagementRequestBase & {
      type: 'read-agents'
      sessionIds?: string[]
      includeCaller?: boolean
      maxMessagesPerAgent?: number
      maxCharsPerMessage?: number
      maxCharsPerAgent?: number
      maxTotalChars?: number
    })
  | (AgentManagementRequestBase & {
      type: 'send-prompt'
      sessionId: string
      prompt: string
    })
  | (AgentManagementRequestBase & {
      type: 'close-agent'
      sessionId: string
    })

export type AgentManagementRendererResponse =
  | {
      requestId: string
      ok: true
      type: 'list-agents'
      observedAt: number
      project: ManagedAgentProject
      agents: ManagedAgentRendererDescriptor[]
    }
  | {
      requestId: string
      ok: true
      type: 'read-agent'
      observedAt: number
      output: ManagedAgentRendererOutput
    }
  | {
      requestId: string
      ok: true
      type: 'read-agents'
      observedAt: number
      project: ManagedAgentProject
      agents: ManagedAgentRendererDescriptor[]
      outputs: ManagedAgentRendererOutput[]
      unavailable: Array<{
        sessionId: string
        reason: 'transcript_unavailable' | 'not_created'
      }>
      truncated: boolean
      totalChars: number
    }
  | {
      requestId: string
      ok: true
      type: 'send-prompt'
      sessionId: string
      delivery: PromptDeliveryResult
    }
  | {
      requestId: string
      ok: true
      type: 'close-agent'
      closedSessionId: string
    }
  | {
      requestId: string
      ok: false
      type: AgentManagementRendererRequest['type']
      code:
        | 'caller_not_found'
        | 'agent_not_found'
        | 'agent_not_in_project'
        | 'self_target_forbidden'
        | 'transcript_unavailable'
        | 'close_would_affect_additional_sessions'
        | 'request_failed'
      message: string
      sessionId?: string
      additionalAffectedSessionIds?: string[]
    }

export type AgentManagementSessionFactsRequest = {
  sessionId: string
  kind: AgentProviderKind
  cwd: string
  providerSessionId?: string
}

export type AgentManagementSessionFacts = {
  sessionId: string
  backendState: ManagedAgentBackendState
  backendActivityAt?: number
  transcriptPath: string | null
  transcriptAvailability: ManagedAgentTranscriptAvailability
  transcriptLastModifiedAt?: number
}
