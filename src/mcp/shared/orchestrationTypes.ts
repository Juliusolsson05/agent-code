import type { BuiltInMcpDomain } from '@mcp/shared/types.js'

export type OrchestrationAgentKind = 'claude' | 'codex'

export type OrchestrationCreateAgentRequest = {
  requestId: string
  type: 'create-agent'
  parentSessionId: string
  kind: OrchestrationAgentKind
  cwd?: string
  title?: string
  role?: string
  runId?: string
  builtInMcpDomains?: BuiltInMcpDomain[]
  inheritParentContext?: boolean
}

export type OrchestrationListAgentsRequest = {
  requestId: string
  type: 'list-agents'
  parentSessionId: string
  runId?: string
}

export type OrchestrationReadAgentRequest = {
  requestId: string
  type: 'read-agent'
  parentSessionId: string
  sessionId: string
  maxMessages?: number
}

export type OrchestrationReadRunOutputsRequest = {
  requestId: string
  type: 'read-run-outputs'
  parentSessionId: string
  runId?: string
  maxMessagesPerAgent?: number
}

export type OrchestrationCloseAgentRequest = {
  requestId: string
  type: 'close-agent'
  parentSessionId: string
  sessionId: string
}

export type OrchestrationCloseRunRequest = {
  requestId: string
  type: 'close-run'
  parentSessionId: string
  runId?: string
}

export type OrchestrationMarkBootstrapPromptDeliveredRequest = {
  requestId: string
  type: 'mark-bootstrap-prompt-delivered'
  parentSessionId: string
  sessionId: string
}

export type OrchestrationRendererRequest =
  | OrchestrationCreateAgentRequest
  | OrchestrationListAgentsRequest
  | OrchestrationReadAgentRequest
  | OrchestrationReadRunOutputsRequest
  | OrchestrationCloseAgentRequest
  | OrchestrationCloseRunRequest
  | OrchestrationMarkBootstrapPromptDeliveredRequest

export type OrchestrationLifecycleState =
  | 'created'
  | 'prompt_sent'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'closed'
  | 'interrupted'

export type OrchestrationAgentMessage = {
  role: 'user' | 'assistant'
  text: string
  timestamp?: string
}

export type OrchestrationAgentRecord = {
  sessionId: string
  kind: OrchestrationAgentKind
  cwd: string
  title?: string
  orchestrationParentId: string
  orchestrationRootId: string
  orchestrationRunId?: string
  orchestrationRole?: string
  inheritedParentContext?: boolean
  inheritedParentProviderSessionId?: string
  inheritedProviderSessionId?: string
  orchestrationBootstrapPromptDelivered?: boolean
  lifecycleState?: OrchestrationLifecycleState
  createdAt?: number
  lastActivityAt?: number
  completedAt?: number
  lastPromptSubmittedAt?: number
  promptSubmissionCount?: number
  promptSubmitted?: boolean
  statusSummary?: string
  errorSummary?: string
  latestAssistantText?: string
  finalAssistantText?: string
  messageCount?: number
}

export type OrchestrationAgentOutput = {
  agent: OrchestrationAgentRecord
  messages: OrchestrationAgentMessage[]
  latestAssistantText?: string
  finalAssistantText?: string
}

export type OrchestrationCloseResult = {
  closedSessionIds: string[]
  skippedSessionIds?: string[]
}

export type OrchestrationRendererResponse =
  | {
      requestId: string
      ok: true
      type: 'create-agent'
      agent: OrchestrationAgentRecord
    }
  | {
      requestId: string
      ok: true
      type: 'list-agents'
      agents: OrchestrationAgentRecord[]
    }
  | {
      requestId: string
      ok: true
      type: 'read-agent'
      output: OrchestrationAgentOutput
    }
  | {
      requestId: string
      ok: true
      type: 'read-run-outputs'
      outputs: OrchestrationAgentOutput[]
    }
  | {
      requestId: string
      ok: true
      type: 'close-agent' | 'close-run'
      result: OrchestrationCloseResult
    }
  | {
      requestId: string
      ok: true
      type: 'mark-bootstrap-prompt-delivered'
      agent: OrchestrationAgentRecord
    }
  | {
      requestId: string
      ok: false
      type: OrchestrationRendererRequest['type']
      message: string
    }
