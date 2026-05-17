import { randomUUID } from 'node:crypto'

import { sendToMainWindow } from '@main/window/mainWindow.js'
import type {
  OrchestrationAgentKind,
  OrchestrationAgentOutput,
  OrchestrationAgentRecord,
  OrchestrationCloseResult,
  OrchestrationRendererRequest,
  OrchestrationRendererResponse,
} from '@mcp/shared/orchestrationTypes.js'
import type { BuiltInMcpDomain } from '@mcp/shared/types.js'

type PendingRequest = {
  resolve: (response: OrchestrationRendererResponse) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

type PromptDeliveryMetadata = {
  createdAt: number
  lastPromptSubmittedAt?: number
  promptSubmissionCount: number
}

type ClosedAgentRecord = {
  output: OrchestrationAgentOutput
  closedAt: number
}

const MAX_PROMPT_DELIVERIES = 1000
const MAX_CLOSED_AGENTS = 500
const ORCHESTRATION_METADATA_TTL_MS = 24 * 60 * 60 * 1000

export class OrchestrationBridge {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly promptDeliveries = new Map<string, PromptDeliveryMetadata>()
  private readonly closedAgents = new Map<string, ClosedAgentRecord>()

  async createAgent(params: {
    parentSessionId: string
    kind: OrchestrationAgentKind
    cwd?: string
    title?: string
    role?: string
    runId?: string
    builtInMcpDomains?: BuiltInMcpDomain[]
  }): Promise<OrchestrationAgentRecord> {
    const response = await this.request({
      requestId: randomUUID(),
      type: 'create-agent',
      ...params,
    })
    if (!response.ok) throw new Error(response.message)
    if (response.type !== 'create-agent') {
      throw new Error(`Unexpected orchestration response: ${response.type}`)
    }
    this.promptDeliveries.set(response.agent.sessionId, {
      createdAt: Date.now(),
      promptSubmissionCount: 0,
    })
    this.closedAgents.delete(response.agent.sessionId)
    return this.enrichAgent(response.agent)
  }

  async listAgents(params: {
    parentSessionId: string
    runId?: string
  }): Promise<OrchestrationAgentRecord[]> {
    this.pruneCoordinationMetadata()
    const response = await this.request({
      requestId: randomUUID(),
      type: 'list-agents',
      ...params,
    })
    if (!response.ok) throw new Error(response.message)
    if (response.type !== 'list-agents') {
      throw new Error(`Unexpected orchestration response: ${response.type}`)
    }
    return this.mergeClosedAgents({
      parentSessionId: params.parentSessionId,
      runId: params.runId,
      liveAgents: response.agents.map(agent => this.enrichAgent(agent)),
    })
  }

  async readAgent(params: {
    parentSessionId: string
    sessionId: string
    maxMessages?: number
  }): Promise<OrchestrationAgentOutput> {
    this.pruneCoordinationMetadata()
    const response = await this.request({
      requestId: randomUUID(),
      type: 'read-agent',
      ...params,
    }).catch(err => {
      const closed = this.closedAgentOutput(params)
      if (closed) return {
        requestId: '',
        ok: true as const,
        type: 'read-agent' as const,
        output: closed,
      }
      throw err
    })
    if (!response.ok) {
      const closed = this.closedAgentOutput(params)
      if (closed) return closed
      throw new Error(response.message)
    }
    if (response.type !== 'read-agent') {
      throw new Error(`Unexpected orchestration response: ${response.type}`)
    }
    return this.enrichOutput(response.output)
  }

  async readRunOutputs(params: {
    parentSessionId: string
    runId?: string
    maxMessagesPerAgent?: number
  }): Promise<OrchestrationAgentOutput[]> {
    this.pruneCoordinationMetadata()
    const response = await this.request({
      requestId: randomUUID(),
      type: 'read-run-outputs',
      ...params,
    })
    if (!response.ok) throw new Error(response.message)
    if (response.type !== 'read-run-outputs') {
      throw new Error(`Unexpected orchestration response: ${response.type}`)
    }
    return this.mergeClosedOutputs({
      parentSessionId: params.parentSessionId,
      runId: params.runId,
      liveOutputs: response.outputs.map(output => this.enrichOutput(output)),
      maxMessagesPerAgent: params.maxMessagesPerAgent,
    })
  }

  async closeAgent(params: {
    parentSessionId: string
    sessionId: string
  }): Promise<OrchestrationCloseResult> {
    this.pruneCoordinationMetadata()
    const before = await this.readAgent({
      parentSessionId: params.parentSessionId,
      sessionId: params.sessionId,
      maxMessages: 100,
    }).catch(() => null)
    const response = await this.request({
      requestId: randomUUID(),
      type: 'close-agent',
      ...params,
    })
    if (!response.ok) throw new Error(response.message)
    if (response.type !== 'close-agent' && response.type !== 'close-run') {
      throw new Error(`Unexpected orchestration response: ${response.type}`)
    }
    if (before && response.result.closedSessionIds.includes(params.sessionId)) {
      this.noteClosed(before)
    }
    return response.result
  }

  async closeRun(params: {
    parentSessionId: string
    runId?: string
  }): Promise<OrchestrationCloseResult> {
    this.pruneCoordinationMetadata()
    const before = await this.readRunOutputs({
      parentSessionId: params.parentSessionId,
      runId: params.runId,
      maxMessagesPerAgent: 100,
    }).catch(() => [])
    const response = await this.request({
      requestId: randomUUID(),
      type: 'close-run',
      ...params,
    })
    if (!response.ok) throw new Error(response.message)
    if (response.type !== 'close-agent' && response.type !== 'close-run') {
      throw new Error(`Unexpected orchestration response: ${response.type}`)
    }
    const closed = new Set(response.result.closedSessionIds)
    for (const output of before) {
      if (closed.has(output.agent.sessionId)) this.noteClosed(output)
    }
    return response.result
  }

  notePromptSubmitted(sessionId: string): void {
    this.pruneCoordinationMetadata()
    const now = Date.now()
    const current = this.promptDeliveries.get(sessionId) ?? {
      createdAt: now,
      promptSubmissionCount: 0,
    }
    const next = {
      ...current,
      lastPromptSubmittedAt: now,
      promptSubmissionCount: current.promptSubmissionCount + 1,
    }
    this.promptDeliveries.delete(sessionId)
    this.promptDeliveries.set(sessionId, next)
  }

  resolve(response: OrchestrationRendererResponse): void {
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(response.requestId)
    pending.resolve(response)
  }

  private async request(
    request: OrchestrationRendererRequest,
  ): Promise<OrchestrationRendererResponse> {
    // WHY orchestration uses a renderer request bridge instead of creating
    // child sessions directly in main:
    //
    // SessionManager can spawn provider processes, but it does not own the
    // workspace model: detached Dispatch placement, parent project affinity,
    // titles, persisted metadata, and future multi-window behavior all live in
    // the renderer workspace store. An orchestration agent must create a REAL
    // Agent Code agent that the user can see and manage, so main asks the
    // renderer to perform the workspace mutation and only handles MCP/PTY work
    // around it.
    return await new Promise<OrchestrationRendererResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId)
        reject(new Error('Timed out waiting for renderer orchestration response'))
      }, 30_000)
      this.pending.set(request.requestId, { resolve, reject, timer })
      sendToMainWindow('orchestration:request', request)
    })
  }

  private enrichOutput(output: OrchestrationAgentOutput): OrchestrationAgentOutput {
    return {
      ...output,
      agent: this.enrichAgent(output.agent),
    }
  }

  private enrichAgent(agent: OrchestrationAgentRecord): OrchestrationAgentRecord {
    const delivery = this.promptDeliveries.get(agent.sessionId)
    if (!delivery) return agent
    const lifecycleState = this.lifecycleWithPromptDelivery(agent, delivery)
    return {
      ...agent,
      ...this.promptFields(delivery),
      lifecycleState,
    }
  }

  private noteClosed(output: OrchestrationAgentOutput): void {
    const closedAt = Date.now()
    const agent: OrchestrationAgentRecord = {
      ...this.enrichAgent(output.agent),
      lifecycleState: 'closed',
      completedAt: output.agent.completedAt ?? output.agent.lastActivityAt,
      lastActivityAt: closedAt,
      statusSummary: 'closed',
    }
    // WHY main keeps a small tombstone for MCP-closed children:
    // closing a session correctly removes it from the renderer workspace, so a
    // later renderer-backed list cannot see it. Orchestration coordination,
    // however, needs "closed" to be a state, not absence. We only tombstone
    // agents closed through this MCP bridge because those are the closures a
    // parent agent can coordinate; arbitrary user-closed panes should not turn
    // main into a second persistent workspace registry.
    this.closedAgents.delete(agent.sessionId)
    this.closedAgents.set(agent.sessionId, {
      closedAt,
      output: {
        ...output,
        agent,
      },
    })
    this.pruneCoordinationMetadata()
  }

  private closedAgentOutput(params: {
    parentSessionId: string
    sessionId: string
    maxMessages?: number
  }): OrchestrationAgentOutput | null {
    const closed = this.closedAgents.get(params.sessionId)
    if (!closed) return null
    if (!this.agentMatchesParent(closed.output.agent, params.parentSessionId)) return null
    return this.limitOutputMessages(closed.output, params.maxMessages)
  }

  private lifecycleWithPromptDelivery(
    agent: OrchestrationAgentRecord,
    delivery: PromptDeliveryMetadata,
  ): OrchestrationAgentRecord['lifecycleState'] {
    if (delivery.promptSubmissionCount === 0) return agent.lifecycleState
    if (agent.lifecycleState === 'created' || agent.lifecycleState === 'waiting') {
      return 'prompt_sent'
    }
    const lastSubmittedAt = delivery.lastPromptSubmittedAt
    if (!lastSubmittedAt || agent.lifecycleState !== 'completed') return agent.lifecycleState
    const lastAgentActivityAt = Math.max(
      agent.completedAt ?? 0,
      agent.lastActivityAt ?? 0,
    )
    // WHY prompt_sent can override a completed renderer state:
    // the renderer derives "completed" from the latest visible assistant row.
    // Immediately after a follow-up prompt is submitted, that old assistant
    // row is still the latest durable output until the provider starts
    // streaming. Without comparing prompt time to output time, wait_agents
    // would treat an iterative child as done during the small but important
    // post-submit/pre-stream window.
    return lastSubmittedAt >= lastAgentActivityAt ? 'prompt_sent' : agent.lifecycleState
  }

  private mergeClosedAgents(params: {
    parentSessionId: string
    runId?: string
    liveAgents: OrchestrationAgentRecord[]
  }): OrchestrationAgentRecord[] {
    const seen = new Set(params.liveAgents.map(agent => agent.sessionId))
    const closed = Array.from(this.closedAgents.values())
      .filter(item => !seen.has(item.output.agent.sessionId))
      .filter(item => this.agentMatchesParent(item.output.agent, params.parentSessionId))
      .filter(item => params.runId ? item.output.agent.orchestrationRunId === params.runId : true)
      .sort((a, b) => a.closedAt - b.closedAt)
      .map(item => item.output.agent)
    return [...params.liveAgents, ...closed]
  }

  private mergeClosedOutputs(params: {
    parentSessionId: string
    runId?: string
    liveOutputs: OrchestrationAgentOutput[]
    maxMessagesPerAgent?: number
  }): OrchestrationAgentOutput[] {
    const seen = new Set(params.liveOutputs.map(output => output.agent.sessionId))
    const closed = Array.from(this.closedAgents.values())
      .filter(item => !seen.has(item.output.agent.sessionId))
      .filter(item => this.agentMatchesParent(item.output.agent, params.parentSessionId))
      .filter(item => params.runId ? item.output.agent.orchestrationRunId === params.runId : true)
      .sort((a, b) => a.closedAt - b.closedAt)
      .map(item => this.limitOutputMessages(item.output, params.maxMessagesPerAgent))
    return [...params.liveOutputs, ...closed]
  }

  private agentMatchesParent(agent: OrchestrationAgentRecord, parentSessionId: string): boolean {
    return (
      agent.orchestrationParentId === parentSessionId ||
      agent.orchestrationRootId === parentSessionId
    )
  }

  private limitOutputMessages(
    output: OrchestrationAgentOutput,
    maxMessages: number | undefined,
  ): OrchestrationAgentOutput {
    if (maxMessages === undefined) return output
    const limit = Math.max(1, Math.min(100, Math.floor(maxMessages)))
    return {
      ...output,
      messages: output.messages.slice(-limit),
    }
  }

  private promptFields(delivery: PromptDeliveryMetadata): Partial<OrchestrationAgentRecord> {
    return {
      createdAt: delivery.createdAt,
      promptSubmissionCount: delivery.promptSubmissionCount,
      promptSubmitted: delivery.promptSubmissionCount > 0,
      ...(delivery.lastPromptSubmittedAt
        ? { lastPromptSubmittedAt: delivery.lastPromptSubmittedAt }
        : {}),
    }
  }

  private pruneCoordinationMetadata(now = Date.now()): void {
    // WHY cap these maps in main:
    // orchestration metadata is useful coordination state, not durable app
    // history. The renderer owns live workspace sessions; main only remembers
    // prompt delivery and MCP-closed tombstones so a parent agent can reason
    // about recent children. Leaving those maps unbounded in a long-running
    // desktop app would retain old outputs indefinitely.
    for (const [sessionId, delivery] of this.promptDeliveries) {
      const latest = delivery.lastPromptSubmittedAt ?? delivery.createdAt
      if (now - latest > ORCHESTRATION_METADATA_TTL_MS) {
        this.promptDeliveries.delete(sessionId)
      }
    }
    trimMapToNewest(this.promptDeliveries, MAX_PROMPT_DELIVERIES)

    for (const [sessionId, record] of this.closedAgents) {
      if (now - record.closedAt > ORCHESTRATION_METADATA_TTL_MS) {
        this.closedAgents.delete(sessionId)
      }
    }
    trimMapToNewest(this.closedAgents, MAX_CLOSED_AGENTS)
  }
}

function trimMapToNewest<K, V>(map: Map<K, V>, maxSize: number): void {
  while (map.size > maxSize) {
    const oldest = map.keys().next()
    if (oldest.done) return
    map.delete(oldest.value)
  }
}
