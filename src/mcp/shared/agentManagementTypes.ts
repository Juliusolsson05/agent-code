import type { AgentProviderKind } from '@shared/types/providerKind.js'
import type { PromptDeliveryResult } from '@shared/types/providerConfig.js'

// One value since the unified layout (#992): every managed agent is a row in
// its project's agent index. The union kept 'grid' and 'buried' for one
// release after nothing produced them (they named v2 owner structures that
// no longer exist) and narrows here — stage 7 — so a caller still switching
// on the removed values fails to compile instead of silently never matching.
export type ManagedAgentPlacement = 'dispatch'

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

// No provider is special-cased here: an OpenCode session is `available` with
// an `opencode://session/<id>` path, which the agent transcript tools read
// like any JSONL path. (A former `provider_managed` value marked OpenCode as
// unreadable before those tools could read its database.)
export type ManagedAgentTranscriptAvailability =
  | 'available'
  | 'not_created'
  | 'unavailable'

/**
 * Which class of evidence a published `lastActivityAt` rests on. An auditing
 * agent cites it, and the design doc ranks these deliberately: a real
 * transcript record outranks a clock that a screen repaint can move
 * (docs/superpowers/plans/2026-07-23-open-agent-mcp-control.md).
 */
export type ManagedAgentActivitySource = 'transcript' | 'runtime' | 'backend'

/** The subset the RENDERER can decide: it has no view of the backend's clock. */
export type ManagedAgentRendererActivitySource = Exclude<ManagedAgentActivitySource, 'backend'>

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
  lastActivitySource?: ManagedAgentActivitySource
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
  /**
   * The ONE answer to "when was this agent last active" (#915), shared with
   * the TLDR peek footer via `sessionActivity`, plus which class of evidence
   * produced it.
   *
   * WHY the renderer decides the source and the bridge does not: the bridge
   * sees this as a single number and would have to label it by where it
   * arrived from, which is how a JSONL watermark came to be published as
   * `lastActivitySource: 'runtime'` — the value right, the citation wrong
   * (review of #1080). Only the renderer knows whether a transcript record or
   * a runtime clock won.
   *
   * This type is renderer-private and never serialised to an MCP caller (see
   * `providerSessionId` above); its sole consumer is `AgentManagementBridge`,
   * in the same binary. An earlier version also carried the raw
   * `transcriptActivityAt`/`runtimeActivityAt` components "because an existing
   * caller may read them" — there is no such caller, and once the bridge
   * stopped recombining them nothing read them at all, so they are gone.
   */
  lastActiveAt?: number
  lastActiveSource?: ManagedAgentRendererActivitySource
}

export type ManagedAgentRendererOutput = {
  output: ManagedAgentTranscriptOutput
  providerSessionId?: string
  /** See `ManagedAgentRendererDescriptor.lastActiveAt` (#915). */
  lastActiveAt?: number
  lastActiveSource?: ManagedAgentRendererActivitySource
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
