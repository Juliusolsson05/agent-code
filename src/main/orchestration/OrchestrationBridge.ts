import { randomUUID } from 'node:crypto'

import { sendToWindow, windowForSession } from '@main/window/windowRegistry.js'
import type {
  OrchestrationAgentKind,
  OrchestrationAgentMessage,
  OrchestrationAgentOutput,
  OrchestrationAgentRecord,
  OrchestrationCloseResult,
  OrchestrationRendererRequest,
  OrchestrationRendererResponse,
} from '@mcp/shared/orchestrationTypes.js'
import type { BuiltInMcpDomain } from '@mcp/shared/types.js'
import type { AppRunJournal } from '@main/incident/AppRunJournal.js'

type PendingRequest = {
  resolve: (response: OrchestrationRendererResponse) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

type QueuedRendererRequest = {
  request: OrchestrationRendererRequest
  resolve: (response: OrchestrationRendererResponse) => void
  reject: (err: Error) => void
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

type CachedValue<T> = {
  expiresAt: number
  promise: Promise<T>
}

const MAX_PROMPT_DELIVERIES = 1000
const MAX_CLOSED_AGENTS = 500
const MAX_CLOSED_AGENT_MESSAGES = 100
// Defense-in-depth char budget for one stored tombstone (#373). The renderer
// already byte-caps read outputs (default 24_000 chars per agent), so in
// practice tombstones arrive far smaller than this. The clamp exists because
// noteClosed stores whatever the pre-close read returned VERBATIM and keeps it
// for up to 24h x 500 agents — if a renderer version without caps (or a future
// caller passing a huge explicit maxCharsPerAgent) feeds this map, main must
// still have a hard ceiling. 256 KiB preserves any plausible final answer
// while bounding worst-case retention to ~128 MB instead of "unbounded".
const MAX_CLOSED_AGENT_CHARS = 262_144
// Any single mirror text field (latest/finalAssistantText on the output and
// its agent record). The renderer sends short excerpts for the record-level
// mirrors and a per-message-capped copy at output.latestAssistantText, so
// this only binds for stale/uncapped senders. Kept well below
// MAX_CLOSED_AGENT_CHARS because these fields used to be the 5x/7x
// duplication vector (see orchestrationMcp.buildAgentOutput).
const MAX_CLOSED_AGENT_TEXT_FIELD_CHARS = 16_384
const ORCHESTRATION_METADATA_TTL_MS = 24 * 60 * 60 * 1000
const PRUNE_INTERVAL_MS = 5 * 60 * 1000
const MAX_ACTIVE_RENDERER_REQUESTS = 1
const STATUS_CACHE_TTL_MS = 250

export class OrchestrationBridge {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly rendererQueue: QueuedRendererRequest[] = []
  private activeRendererRequests = 0
  private readonly promptDeliveries = new Map<string, PromptDeliveryMetadata>()
  private readonly closedAgents = new Map<string, ClosedAgentRecord>()
  private readonly parentSessionByChildSession = new Map<string, string>()
  private readonly listAgentsCache = new Map<string, CachedValue<OrchestrationAgentRecord[]>>()
  private readonly readRunOutputsCache = new Map<string, CachedValue<OrchestrationAgentOutput[]>>()
  private lastPrunedAt = 0
  // Always-on incident journal, injected post-construction in startApp — the
  // bridge is created at module-eval, before the journal exists.
  private journal: AppRunJournal | null = null

  setJournal(journal: AppRunJournal): void {
    this.journal = journal
  }

  async createAgent(params: {
    parentSessionId: string
    kind: OrchestrationAgentKind
    cwd?: string
    title?: string
    role?: string
    runId?: string
    builtInMcpDomains?: BuiltInMcpDomain[]
    inheritParentContext?: boolean
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
    this.parentSessionByChildSession.set(response.agent.sessionId, params.parentSessionId)
    this.closedAgents.delete(response.agent.sessionId)
    this.invalidateStatusCache(params.parentSessionId)
    return this.enrichAgent(response.agent)
  }

  async listAgents(params: {
    parentSessionId: string
    runId?: string
  }): Promise<OrchestrationAgentRecord[]> {
    this.pruneCoordinationMetadata()
    return await this.cachedListAgents(params)
  }

  async readAgent(params: {
    parentSessionId: string
    sessionId: string
    maxMessages?: number
    maxCharsPerMessage?: number
    maxCharsPerAgent?: number
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
    maxCharsPerMessage?: number
    maxCharsPerAgent?: number
  }): Promise<OrchestrationAgentOutput[]> {
    this.pruneCoordinationMetadata()
    return await this.cachedReadRunOutputs(params)
  }

  async closeAgent(params: {
    parentSessionId: string
    sessionId: string
  }): Promise<OrchestrationCloseResult> {
    this.pruneCoordinationMetadata()
    const before = await this.readAgent({
      parentSessionId: params.parentSessionId,
      sessionId: params.sessionId,
      maxMessages: MAX_CLOSED_AGENT_MESSAGES,
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
    this.invalidateStatusCache(params.parentSessionId)
    this.parentSessionByChildSession.delete(params.sessionId)
    // Prompt-delivery metadata is keyed by the same child lifetime. Keeping it
    // after close cannot help recovery—the session id is no longer writable—
    // and high-churn orchestration runs otherwise retain one dead record per
    // child until the coarse global pruning threshold is reached.
    this.promptDeliveries.delete(params.sessionId)
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
      maxMessagesPerAgent: MAX_CLOSED_AGENT_MESSAGES,
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
    this.invalidateStatusCache(params.parentSessionId)
    for (const sessionId of response.result.closedSessionIds) {
      this.parentSessionByChildSession.delete(sessionId)
      this.promptDeliveries.delete(sessionId)
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
    this.invalidateStatusCacheForSession(sessionId)
  }

  promptSubmissionCount(sessionId: string): number {
    return this.promptDeliveries.get(sessionId)?.promptSubmissionCount ?? 0
  }

  async markBootstrapPromptDelivered(params: {
    parentSessionId: string
    sessionId: string
  }): Promise<OrchestrationAgentRecord> {
    const response = await this.request({
      requestId: randomUUID(),
      type: 'mark-bootstrap-prompt-delivered',
      parentSessionId: params.parentSessionId,
      sessionId: params.sessionId,
    })
    if (!response.ok) throw new Error(response.message)
    if (response.type !== 'mark-bootstrap-prompt-delivered') {
      throw new Error(`Unexpected orchestration response: ${response.type}`)
    }
    this.invalidateStatusCache(params.parentSessionId)
    return this.enrichAgent(response.agent)
  }

  async ensureAgentLive(params: {
    parentSessionId: string
    sessionId: string
  }): Promise<OrchestrationAgentRecord> {
    const response = await this.request({
      requestId: randomUUID(),
      type: 'ensure-agent-live',
      parentSessionId: params.parentSessionId,
      sessionId: params.sessionId,
    })
    if (!response.ok) throw new Error(response.message)
    if (response.type !== 'ensure-agent-live') {
      throw new Error(`Unexpected orchestration response: ${response.type}`)
    }
    this.invalidateStatusCache(params.parentSessionId)
    return this.enrichAgent(response.agent)
  }

  resolve(response: OrchestrationRendererResponse): void {
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(response.requestId)
    pending.resolve(response)
  }

  private async cachedListAgents(params: {
    parentSessionId: string
    runId?: string
  }): Promise<OrchestrationAgentRecord[]> {
    const key = this.statusCacheKey(params)
    const now = Date.now()
    this.pruneStatusCaches(now)
    const cached = this.listAgentsCache.get(key)
    if (cached && cached.expiresAt > now) return await cached.promise

    // WHY cache renderer-backed status reads at all:
    //
    // `orchestration_wait_agents` is intentionally implemented as a polling MCP
    // tool so the parent agent can wait without busy-looping in the model. With
    // 20 orchestrated children, it is common for several wait/list calls to poll
    // the same parent/run during the same quarter-second. Every uncached poll
    // crosses MCP -> main -> renderer -> main -> MCP, and the bridge is
    // deliberately serialized to protect the renderer workspace store. Joining
    // identical short-window reads preserves freshness for human-visible status
    // while preventing a thundering herd of equivalent renderer round-trips.
    const promise = this.request({
      requestId: randomUUID(),
      type: 'list-agents',
      ...params,
    }).then(response => {
      if (!response.ok) throw new Error(response.message)
      if (response.type !== 'list-agents') {
        throw new Error(`Unexpected orchestration response: ${response.type}`)
      }
      return this.mergeClosedAgents({
        parentSessionId: params.parentSessionId,
        runId: params.runId,
        liveAgents: response.agents.map(agent => this.enrichAgent(agent)),
      })
    }).catch(err => {
      if (this.listAgentsCache.get(key)?.promise === promise) {
        this.listAgentsCache.delete(key)
      }
      throw err
    })
    this.listAgentsCache.set(key, {
      expiresAt: now + STATUS_CACHE_TTL_MS,
      promise,
    })
    return await promise
  }

  private async cachedReadRunOutputs(params: {
    parentSessionId: string
    runId?: string
    maxMessagesPerAgent?: number
    maxCharsPerMessage?: number
    maxCharsPerAgent?: number
  }): Promise<OrchestrationAgentOutput[]> {
    // EVERY cap param must be part of this key. The 250ms cache joins
    // identical polls; if two reads differ only in char caps and share a key,
    // one caller silently receives the other's differently-truncated payload
    // (and a big read could be served a tiny excerpt, or vice versa).
    const key = [
      this.statusCacheKey(params),
      `max=${params.maxMessagesPerAgent ?? 'default'}`,
      `mcpm=${params.maxCharsPerMessage ?? 'default'}`,
      `mcpa=${params.maxCharsPerAgent ?? 'default'}`,
    ].join('::')
    const now = Date.now()
    this.pruneStatusCaches(now)
    const cached = this.readRunOutputsCache.get(key)
    if (cached && cached.expiresAt > now) return await cached.promise

    const promise = this.request({
      requestId: randomUUID(),
      type: 'read-run-outputs',
      ...params,
    }).then(response => {
      if (!response.ok) throw new Error(response.message)
      if (response.type !== 'read-run-outputs') {
        throw new Error(`Unexpected orchestration response: ${response.type}`)
      }
      return this.mergeClosedOutputs({
        parentSessionId: params.parentSessionId,
        runId: params.runId,
        liveOutputs: response.outputs.map(output => this.enrichOutput(output)),
        maxMessagesPerAgent: params.maxMessagesPerAgent,
        maxCharsPerMessage: params.maxCharsPerMessage,
        maxCharsPerAgent: params.maxCharsPerAgent,
      })
    }).catch(err => {
      if (this.readRunOutputsCache.get(key)?.promise === promise) {
        this.readRunOutputsCache.delete(key)
      }
      throw err
    })
    this.readRunOutputsCache.set(key, {
      expiresAt: now + STATUS_CACHE_TTL_MS,
      promise,
    })
    return await promise
  }

  private statusCacheKey(params: { parentSessionId: string; runId?: string }): string {
    return `${params.parentSessionId}::${params.runId ?? ''}`
  }

  private invalidateStatusCache(parentSessionId?: string): void {
    if (!parentSessionId) {
      this.listAgentsCache.clear()
      this.readRunOutputsCache.clear()
      return
    }
    const prefix = `${parentSessionId}::`
    for (const key of this.listAgentsCache.keys()) {
      if (key.startsWith(prefix)) this.listAgentsCache.delete(key)
    }
    for (const key of this.readRunOutputsCache.keys()) {
      if (key.startsWith(prefix)) this.readRunOutputsCache.delete(key)
    }
  }

  private invalidateStatusCacheForSession(sessionId: string): void {
    const parentSessionId = this.parentSessionByChildSession.get(sessionId)
    if (parentSessionId) {
      this.invalidateStatusCache(parentSessionId)
      return
    }
    // WHY fall back to a global clear when the child->parent hint is missing:
    //
    // Main learns the mapping for agents it creates during this app run, but
    // prompt-delivery metadata is intentionally opportunistic and can be rebuilt
    // from a late send_prompt path after old coordination state was pruned. A
    // stale status cache at the prompt boundary is worse than losing a 250 ms
    // optimization, so unknown children still take the conservative path.
    this.invalidateStatusCache()
  }

  private pruneStatusCaches(now: number): void {
    // WHY prune on status reads instead of retaining expired promises until the
    // next structural invalidation:
    //
    // `readRunOutputs` cache values can include transcript slices. The TTL is a
    // freshness contract, but without deletion it would also become a retention
    // contract: every parent/run/maxMessages key touched in a long app run could
    // hold its last fulfilled output forever. Status reads are already the only
    // place these caches matter, so opportunistic pruning gives bounded growth
    // without a timer that wakes the desktop app just to clean a 250 ms cache.
    for (const [key, cached] of this.listAgentsCache) {
      if (cached.expiresAt <= now) this.listAgentsCache.delete(key)
    }
    for (const [key, cached] of this.readRunOutputsCache) {
      if (cached.expiresAt <= now) this.readRunOutputsCache.delete(key)
    }
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
      this.rendererQueue.push({ request, resolve, reject })
      this.drainRendererQueue()
    })
  }

  private drainRendererQueue(): void {
    while (
      this.activeRendererRequests < MAX_ACTIVE_RENDERER_REQUESTS &&
      this.rendererQueue.length > 0
    ) {
      const next = this.rendererQueue.shift()!
      this.activeRendererRequests += 1
      void this.dispatchRendererRequest(next.request)
        .then(next.resolve, next.reject)
        .finally(() => {
          this.activeRendererRequests -= 1
          this.drainRendererQueue()
        })
    }
  }

  private async dispatchRendererRequest(
    request: OrchestrationRendererRequest,
  ): Promise<OrchestrationRendererResponse> {
    return await new Promise<OrchestrationRendererResponse>((resolve, reject) => {
      const TIMEOUT_MS = 30_000
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId)
        // The renderer never answered an orchestration request — JS thread
        // blocked, dead, or crashing mid-handler. Durable evidence of a hang
        // that the renderer itself can't report.
        this.journal?.recordIncident({
          kind: 'orchestration.request_timeout',
          severity: 'error',
          reason: 'renderer_no_response',
          context: { requestId: request.requestId, waitedMs: TIMEOUT_MS },
        })
        reject(new Error('Timed out waiting for renderer orchestration response'))
      }, TIMEOUT_MS)
      this.pending.set(request.requestId, { resolve, reject, timer })
      // WHY main serializes renderer-backed orchestration requests:
      // every request crosses into the renderer's workspace model, and some of
      // them used to perform transcript/status scans over every child. Bulk
      // parent prompts can otherwise enqueue a burst of read/list/ensure/mark
      // events that competes with React state updates and makes the bridge miss
      // its own 30s timeout. Serializing preserves correctness and backpressure:
      // callers wait in main, while the renderer only handles one orchestration
      // mutation/read at a time.
      //
      // WHY the request is addressed to the window owning the PARENT session
      // rather than broadcast: every variant carries `parentSessionId`, and the
      // request mutates that window's workspace store (detached placement,
      // project affinity, titles). Broadcasting would have every window answer
      // the same `requestId` from a different workspace model, and main would
      // resolve whichever reply raced first.
      //
      // WHY an unowned parent rejects rather than falling back to the focused
      // window: this bridge is fail-closed by design, and creating or closing a
      // real agent in a workspace the caller does not belong to is worse than
      // returning an error the calling agent can read and retry.
      const target = windowForSession(request.parentSessionId)
      if (!target) {
        clearTimeout(timer)
        this.pending.delete(request.requestId)
        reject(new Error(
          `No Agent Code window owns orchestration parent session ${request.parentSessionId}`,
        ))
        return
      }
      sendToWindow(target, 'orchestration:request', request)
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
    //
    // The stored output is byte-clamped (#373): "small tombstone" was only
    // true for message COUNT before — one child that answered with a huge
    // blob was stored verbatim and re-served on every later read of the
    // closed agent, for up to 24h. See MAX_CLOSED_AGENT_CHARS.
    this.closedAgents.delete(agent.sessionId)
    this.closedAgents.set(agent.sessionId, {
      closedAt,
      output: clampClosedAgentOutput({
        ...output,
        agent,
      }),
    })
    this.pruneCoordinationMetadata()
  }

  private closedAgentOutput(params: {
    parentSessionId: string
    sessionId: string
    maxMessages?: number
    maxCharsPerMessage?: number
    maxCharsPerAgent?: number
  }): OrchestrationAgentOutput | null {
    const closed = this.closedAgents.get(params.sessionId)
    if (!closed) return null
    if (!this.agentMatchesParent(closed.output.agent, params.parentSessionId)) return null
    return this.limitOutputMessages(closed.output, params)
  }

  private lifecycleWithPromptDelivery(
    agent: OrchestrationAgentRecord,
    delivery: PromptDeliveryMetadata,
  ): OrchestrationAgentRecord['lifecycleState'] {
    // STAGE 2 of 2: renderer state says what the child appears to be doing,
    // while main alone knows when orchestration submitted a prompt. Keep this
    // overlay paired with lifecycleStateForRuntime in orchestrationMcp.ts.
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
    if (this.closedAgents.size === 0) return params.liveAgents
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
    maxCharsPerMessage?: number
    maxCharsPerAgent?: number
  }): OrchestrationAgentOutput[] {
    if (this.closedAgents.size === 0) return params.liveOutputs
    const seen = new Set(params.liveOutputs.map(output => output.agent.sessionId))
    const closed = Array.from(this.closedAgents.values())
      .filter(item => !seen.has(item.output.agent.sessionId))
      .filter(item => this.agentMatchesParent(item.output.agent, params.parentSessionId))
      .filter(item => params.runId ? item.output.agent.orchestrationRunId === params.runId : true)
      .sort((a, b) => a.closedAt - b.closedAt)
      .map(item => this.limitOutputMessages(item.output, {
        maxMessages: params.maxMessagesPerAgent,
        maxCharsPerMessage: params.maxCharsPerMessage,
        maxCharsPerAgent: params.maxCharsPerAgent,
      }))
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
    caps: {
      maxMessages?: number
      maxCharsPerMessage?: number
      maxCharsPerAgent?: number
    },
  ): OrchestrationAgentOutput {
    // WHY this exists on top of the renderer-side caps: tombstoned outputs are
    // served from main's memory without any renderer round-trip, so the caps a
    // caller passes to read_agent/read_run_outputs must be re-applied here or
    // closed agents would be the one path that ignores them. Char caps are
    // only applied when the caller provided them — the stored tombstone was
    // already read under renderer defaults and clamped by
    // clampClosedAgentOutput, so an uncapped read should see the tombstone
    // as stored, exactly like before #373.
    const { maxMessages, maxCharsPerMessage, maxCharsPerAgent } = caps
    if (
      maxMessages === undefined &&
      maxCharsPerMessage === undefined &&
      maxCharsPerAgent === undefined
    ) {
      return output
    }
    const limit = maxMessages === undefined
      ? output.messages.length
      : Math.max(1, Math.min(100, Math.floor(maxMessages)))
    const sliced = output.messages.slice(-limit)
    const capped = capMessagesByChars(sliced, {
      maxCharsPerMessage: maxCharsPerMessage === undefined
        ? undefined
        : Math.max(50, Math.min(100_000, Math.floor(maxCharsPerMessage))),
      maxCharsPerAgent: maxCharsPerAgent === undefined
        ? undefined
        : Math.max(100, Math.min(500_000, Math.floor(maxCharsPerAgent))),
    })
    const truncated = output.truncated === true ||
      capped.truncated ||
      sliced.length !== output.messages.length
    return {
      ...output,
      messages: capped.messages,
      ...(maxCharsPerMessage !== undefined && output.latestAssistantText
        // Same lifecycle hazard as the renderer: shorten, never drop, so a
        // completed closed child still reads as having durable output.
        ? { latestAssistantText: truncateOrchestrationText(output.latestAssistantText, Math.max(50, Math.floor(maxCharsPerMessage))).text }
        : {}),
      ...(truncated ? { truncated: true } : {}),
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
    if (
      now - this.lastPrunedAt < PRUNE_INTERVAL_MS &&
      this.promptDeliveries.size <= MAX_PROMPT_DELIVERIES &&
      this.closedAgents.size <= MAX_CLOSED_AGENTS
    ) {
      return
    }
    this.lastPrunedAt = now
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
        this.parentSessionByChildSession.delete(sessionId)
      }
    }
    trimMapToNewest(this.promptDeliveries, MAX_PROMPT_DELIVERIES)
    for (const sessionId of this.parentSessionByChildSession.keys()) {
      if (!this.promptDeliveries.has(sessionId)) this.parentSessionByChildSession.delete(sessionId)
    }

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

// Marker deliberately matches AgentTranscriptReader.truncateItemText and
// orchestrationMcp.boundText ("…\n[truncated]", 24-char headroom) so parent
// agents see one truncation dialect everywhere. Duplicated rather than shared
// because main must not import renderer modules and this file predates a
// shared text-utils home; keep the three in sync if the marker ever changes.
function truncateOrchestrationText(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean; totalChars: number } {
  if (text.length <= maxChars) {
    return { text, truncated: false, totalChars: text.length }
  }
  return {
    text: `${text.slice(0, Math.max(0, maxChars - 24))}\n[truncated]`,
    truncated: true,
    totalChars: text.length,
  }
}

// Newest-first char budget over an already count-limited message tail. Walking
// backwards mirrors the renderer's visibleMessageSummary and the transcript
// reader's boundItems: when the budget runs out, the OLDEST messages are the
// ones dropped, because the newest output is what a coordinating parent needs.
// The NEWEST message itself is never dropped — a starved budget truncates it
// down instead (see the floor in the loop), matching the renderer.
function capMessagesByChars(
  messages: OrchestrationAgentMessage[],
  caps: { maxCharsPerMessage?: number; maxCharsPerAgent?: number },
): { messages: OrchestrationAgentMessage[]; truncated: boolean } {
  if (caps.maxCharsPerMessage === undefined && caps.maxCharsPerAgent === undefined) {
    return { messages, truncated: false }
  }
  const perMessage = caps.maxCharsPerMessage ?? Number.POSITIVE_INFINITY
  const budget = caps.maxCharsPerAgent ?? Number.POSITIVE_INFINITY
  const keptReversed: OrchestrationAgentMessage[] = []
  let usedChars = 0
  let truncated = false
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    let bounded = truncateOrchestrationText(message.text, perMessage)
    if (usedChars + bounded.text.length > budget) {
      if (keptReversed.length > 0) {
        truncated = true
        break
      }
      // NEWEST-MESSAGE FLOOR (#510 review): mirrors the identical rule in the
      // renderer's visibleMessageSummary.pushTail. This is the first (newest)
      // message and nothing has been kept yet (usedChars === 0), so a budget
      // smaller than one per-message-capped text must shrink the newest
      // message to fit, not return `messages: []` for a tombstoned agent that
      // has output. The Math.max(100, …) floor is defensive: every current
      // caller clamps maxCharsPerAgent to >=100 (limitOutputMessages) or uses
      // MAX_CLOSED_AGENT_CHARS, but this helper must keep a minimal excerpt
      // even if a future caller passes something absurd. `budget` is finite
      // here — an Infinity budget can never trip the overflow check above.
      bounded = truncateOrchestrationText(message.text, Math.max(100, budget))
      truncated = true
    }
    usedChars += bounded.text.length
    if (bounded.truncated) truncated = true
    keptReversed.push(
      bounded.truncated
        ? { ...message, text: bounded.text, truncated: true, totalChars: message.truncated ? message.totalChars : bounded.totalChars }
        : message,
    )
  }
  return { messages: keptReversed.reverse(), truncated }
}

// Hard ceiling applied once, at storage time (#373). This is deliberately a
// clamp on the STORED record, not on serving: later reads still apply the
// caller's caps via limitOutputMessages, but even a capless caller can never
// pull more than this out of a tombstone, and main's memory stays bounded no
// matter what the pre-close read returned.
function clampClosedAgentOutput(output: OrchestrationAgentOutput): OrchestrationAgentOutput {
  const clampField = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined
    return truncateOrchestrationText(value, MAX_CLOSED_AGENT_TEXT_FIELD_CHARS).text
  }
  const capped = capMessagesByChars(output.messages, {
    maxCharsPerAgent: MAX_CLOSED_AGENT_CHARS,
  })
  const agent = {
    ...output.agent,
    ...(output.agent.latestAssistantText !== undefined
      ? { latestAssistantText: clampField(output.agent.latestAssistantText) }
      : {}),
    ...(output.agent.finalAssistantText !== undefined
      ? { finalAssistantText: clampField(output.agent.finalAssistantText) }
      : {}),
  }
  return {
    ...output,
    agent,
    messages: capped.messages,
    ...(output.latestAssistantText !== undefined
      ? { latestAssistantText: clampField(output.latestAssistantText) }
      : {}),
    ...(output.finalAssistantText !== undefined
      ? { finalAssistantText: clampField(output.finalAssistantText) }
      : {}),
    ...(capped.truncated || output.truncated ? { truncated: true } : {}),
  }
}
