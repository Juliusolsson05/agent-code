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
}

export type OrchestrationListAgentsRequest = {
  requestId: string
  type: 'list-agents'
  parentSessionId: string
  runId?: string
}

export type OrchestrationRendererRequest =
  | OrchestrationCreateAgentRequest
  | OrchestrationListAgentsRequest

export type OrchestrationAgentRecord = {
  sessionId: string
  kind: OrchestrationAgentKind
  cwd: string
  title?: string
  orchestrationParentId: string
  orchestrationRootId: string
  orchestrationRunId?: string
  orchestrationRole?: string
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
      ok: false
      type: OrchestrationRendererRequest['type']
      message: string
    }
