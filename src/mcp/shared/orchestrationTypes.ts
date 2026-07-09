import type { BuiltInMcpDomain } from '@mcp/shared/types.js'
import type { AgentProviderKind } from '@shared/types/providerKind.js'

// Alias, not a re-declared union: orchestration can drive any registered
// agent provider. Keeping the local name preserves this module's public
// surface while the definition now derives from the single source of
// truth (#394 phase 1 — union sprawl).
export type OrchestrationAgentKind = AgentProviderKind

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
  // Byte caps (#373). maxMessages alone was insufficient: a single child
  // message can be hundreds of KB (huge pasted diffs, tool dumps surfacing as
  // assistant text), so count-only limits still let one read blow up the
  // parent's context. Both are advisory caller knobs; the renderer applies
  // safe defaults when they are omitted (see orchestrationMcp.ts).
  maxCharsPerMessage?: number
  maxCharsPerAgent?: number
}

export type OrchestrationReadRunOutputsRequest = {
  requestId: string
  type: 'read-run-outputs'
  parentSessionId: string
  runId?: string
  maxMessagesPerAgent?: number
  // Same rationale as OrchestrationReadAgentRequest (#373), applied per child.
  // The cross-agent total budget (maxTotalChars) is deliberately NOT part of
  // this renderer request: the renderer produces per-agent outputs and main's
  // MCP handler is the only place that sees the whole multi-agent payload plus
  // main-side closed-agent tombstones, so total-budget degradation lives there.
  maxCharsPerMessage?: number
  maxCharsPerAgent?: number
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

export type OrchestrationEnsureAgentLiveRequest = {
  requestId: string
  type: 'ensure-agent-live'
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
  | OrchestrationEnsureAgentLiveRequest

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
  // Set when `text` is an excerpt rather than the full message (#373).
  // `totalChars` is the ORIGINAL character count before truncation, so a
  // parent agent can decide whether the cut content matters enough to re-read
  // with a larger cap or via the transcript tools. Absent means "not cut".
  truncated?: boolean
  totalChars?: number
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
  // DORMANT: current create-agent flows force inheritance off; retained for
  // pre-disable persisted sessions and the planned inheritance redesign.
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
  // BOUNDED EXCERPTS ONLY (#373). Historically these two record fields plus
  // output.latestAssistantText / output.finalAssistantText plus the last
  // messages[] entry all carried the SAME full answer verbatim — one child
  // answer appeared 5x per read_agent response (7x for closed agents in
  // wait_agents, which also returns agents[]). The record-level copies exist
  // purely as at-a-glance status hints, so they are now short excerpts; the
  // single full (per-message-capped) copy lives at output.latestAssistantText.
  latestAssistantText?: string
  finalAssistantText?: string
  messageCount?: number
}

export type OrchestrationAgentOutput = {
  agent: OrchestrationAgentRecord
  messages: OrchestrationAgentMessage[]
  // The ONE full copy of the child's newest assistant text, capped at
  // maxCharsPerMessage. finalAssistantText is kept for callers that already
  // read it, but it is a short excerpt now — see OrchestrationAgentRecord.
  latestAssistantText?: string
  finalAssistantText?: string
  // Set when messages were dropped (count/char budget) or any included text
  // was truncated (#373). `totalChars` estimates the original size of the
  // texts considered for this response — deliberately NOT the whole
  // transcript, because computing that would force full text extraction the
  // bounded read path exists to avoid.
  truncated?: boolean
  totalChars?: number
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
      ok: true
      type: 'ensure-agent-live'
      agent: OrchestrationAgentRecord
    }
  | {
      requestId: string
      ok: false
      type: OrchestrationRendererRequest['type']
      message: string
    }
