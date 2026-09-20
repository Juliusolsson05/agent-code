import { mainOperations } from '@main/performance/operations.js'
import type { OperationEnd } from '@shared/performance/operationTimers.js'
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
import { getMainProvider } from '@providers/registry.main.js'
import type { AgentProviderRuntime } from '@shared/types/providerKind.js'

type PendingRequest = {
  resolve: (response: OrchestrationRendererResponse) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
  /**
   * Set once the caller has given up waiting but the request is still
   * OUTSTANDING in the renderer (#926). The entry stays in `pending` so a late
   * answer can still be reconciled instead of dropped on the floor.
   */
  abandoned?: boolean
}

/**
 * Every renderer request that CHANGES the workspace.
 *
 * WHY the distinction has to exist: a timed-out read changed nothing, so
 * failing it is the whole truth. A timed-out mutation may have happened, may
 * be happening right now, and may complete a second after we gave up — so
 * failing it the same way tells the caller something false.
 *
 * Listed explicitly rather than derived, so a request type added later has to
 * be classified deliberately. The default for anything unlisted is "read",
 * which is the safe side for THIS switch: a mis-classified read is merely a
 * blunt error message, while a mis-classified mutation would hold a
 * reservation nothing ever reconciles.
 */
const MUTATING_REQUEST_TYPES = new Set<OrchestrationRendererRequest['type']>([
  'create-agent',
  'close-agent',
  'close-run',
  'mark-bootstrap-prompt-delivered',
  'ensure-agent-live',
])

/**
 * A dispatched mutation whose outcome nobody knows (#926).
 *
 * ── WHY THIS IS NOT JUST A TIMEOUT ERROR ──
 * By the time the timer fires, the request has been handed to the renderer and
 * the renderer confirmed receipt of the send (see the delivery check in
 * `dispatchRendererRequest` — an UNDELIVERED request never gets here, and is
 * reported as safe to retry instead). What expired is our patience, not the
 * operation. Rejecting with a plain "timed out" told the caller its create had
 * failed, and the reasonable response to a failure is to try again — which is
 * how one intended child becomes two, one of them invisible to the parent that
 * asked for it.
 *
 * `outcome: 'unknown'` is the same vocabulary the control SDK uses for exactly
 * this situation, and it means: do not retry, go and look.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──
 * It does not refuse a later identical create. A first version held a
 * "reservation" keyed on the renderer request shape and refused any matching
 * retry until reconciliation. Review showed that unsound in three ways, all
 * proven against the real bridge:
 *
 *   - The renderer request has no `prompt` field — the prompt is delivered
 *     separately — so two genuinely different fan-out jobs produce a
 *     byte-identical shape, and the second was refused forever. That is the
 *     same catastrophe `createCallsInFlight` above was written to prevent,
 *     reintroduced one layer down.
 *   - Nothing could ever clear it. Listing agents and closing the run both
 *     left it in place, and the message told the agent to list its agents —
 *     so a parent that did exactly as instructed looped with no legal exit.
 *   - Its key disagreed with `orchestrationCreateAgentCallKey` on domain
 *     ordering, so the same intent could miss the guard anyway.
 *
 * A sound guard has to key on something that can see the prompt, which means
 * it belongs at the MCP call layer beside `createAgentCallOnce`, and it needs
 * a terminating condition — a renderer-generation bump is proof the answer can
 * never arrive. Neither is in this change, so #926's "retain scoped
 * conflicting-mutation authority until reconciliation" is NOT delivered here.
 */
export class OrchestrationOutcomeUnknownError extends Error {
  readonly outcome = 'unknown' as const
  constructor(
    readonly requestId: string,
    readonly requestType: OrchestrationRendererRequest['type'],
    readonly parentSessionId: string,
  ) {
    super(
      `The renderer did not answer ${requestType} in time. It may still complete, so the outcome is UNKNOWN: `
      + `do not repeat it. Call orchestration_list_agents for this parent to see what exists before acting.`,
    )
    this.name = 'OrchestrationOutcomeUnknownError'
  }
}

type QueuedRendererRequest = {
  finishQueue: OperationEnd
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
  /**
   * Whole `orchestration_create_agent` TOOL CALLS that are still running,
   * keyed by the call's arguments (#952).
   *
   * ── THE INCIDENT ──
   * On 2026-09-12 one `orchestration_create_agent` call produced TWO children
   * 0.9 s apart, with the same title, cwd, role and prompt, both bootstrapped,
   * both working in the same worktree and writing the same report. Only one
   * was returned, so the parent could not see or close the other and it ran
   * unobserved.
   *
   * ── WHAT WAS RULED OUT, AND WHAT WAS NOT ──
   * Not our retry: `request`/`dispatchRendererRequest` send exactly once,
   * the only timeout is 30 s (which does not match a 0.9 s gap), and the
   * renderer request is addressed to ONE window rather than broadcast — a
   * decision made in `f7b4408a` (Refs #688) because answering an MCP mutation
   * from the wrong window's workspace model is worse than not answering.
   * Not a double renderer handling either: a second `resolveOrchestrationRequest`
   * for an already-resolved requestId is dropped, so the extra child would
   * carry no promptDeliveries entry and no delivered bootstrap prompt — and
   * both children WERE bootstrapped.
   *
   * What that leaves is a second complete tool invocation, which points above
   * this process. It is not, however, something anyone observed, so this does
   * not claim a root cause. It makes the operation idempotent, because the
   * damage is real whatever the cause: duplicate paid agent work, two writers
   * racing on the same files, and side effects performed twice.
   *
   * ── WHY THE KEY IS THE WHOLE CALL, PROMPT INCLUDED ──
   * A first version keyed on the child's SHAPE and deliberately left the
   * prompt out, reasoning that the prompt is delivered after the child exists.
   * Review found that catastrophic: every field but `kind` is optional, so a
   * concurrent FAN-OUT of N workers differing only by prompt — which is the
   * normal way this tool is used, and what "two reviewers per PR" does — all
   * collapsed into one child, and N-1 tasks were silently never run.
   * `MAX_ACTIVE_RENDERER_REQUESTS = 1` makes a burst of creates overlap by
   * construction, so a fan-out was maximally exposed, not least.
   *
   * Two creates that differ by prompt are two different jobs. Only an
   * identical call — same parent, same child shape, same prompt — is a
   * duplicate, and that is what this collapses.
   *
   * ── WHY IT WRAPS THE WHOLE CALL AND NOT `createAgent` ──
   * One invocation is create → deliver the bootstrap prompt → mark delivered,
   * and the delivery is the slow, failure-prone part. Deduping only the create
   * left a duplicate arriving during delivery to spawn a second child, and it
   * handed the duplicate caller a `prompt_delivery_failed` from
   * `deliverPromptToAgent`'s in-flight guard — complete with
   * `retrySafe: true, disposition: 'retry-same-session'`, an instruction to
   * re-send the prompt into the child already running it, plus a false
   * incident in the always-on journal. Deduping the whole call means the
   * duplicate waits and receives the first call's RESULT, which is the only
   * answer that is true for it.
   *
   * ── WHY IN FLIGHT ONLY ──
   * A window over COMPLETED calls would collapse a deliberate "run that exact
   * task again", which is legitimate. Two identical calls overlapping in
   * flight is not something a caller means.
   *
   * It lives on the bridge, not beside the tool handler, because
   * `BuiltInMcpHttpHost` builds a FRESH server with a stateless transport for
   * every POST — a map owned by the server would never see the duplicate.
   */
  private readonly createCallsInFlight = new Map<string, Promise<unknown>>()
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
    providerRuntime?: AgentProviderRuntime
    cwd?: string
    title?: string
    role?: string
    runId?: string
    builtInMcpDomains?: BuiltInMcpDomain[]
    inheritParentContext?: boolean
  }): Promise<OrchestrationAgentRecord> {
    // WHY validate before sending a renderer request: an unsupported launch
    // must fail before a child or ownership record can exist. The factory is
    // the same capability SessionManager uses; a provider-name allowlist would
    // drift when another provider gains a native TUI. Omission stays untouched
    // so a terminal parent does not silently change its children's default.
    if (params.providerRuntime === 'terminal' && !getMainProvider(params.kind).createTerminalSession) {
      throw new Error(`${getMainProvider(params.kind).name} does not support a terminal runtime`)
    }
    const attempt: OrchestrationRendererRequest = {
      requestId: randomUUID(),
      type: 'create-agent',
      ...params,
    }
    const response = await this.request(attempt)
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

  /**
   * Run one `orchestration_create_agent` tool call, or join an identical one
   * that is already running and return ITS result. See `createCallsInFlight`
   * for why this is the unit of deduplication.
   *
   * `key` is the caller's business: the tool handler owns the argument schema
   * and is the only place that can be made to break the build when a new field
   * appears. The bridge owns only the map, because it is the one object that
   * outlives a per-POST MCP server.
   */
  async createAgentCallOnce<T>(key: string, run: () => Promise<T>): Promise<T> {
    const inFlight = this.createCallsInFlight.get(key)
    if (inFlight) return await inFlight as T

    const call = run()
    this.createCallsInFlight.set(key, call)
    try {
      return await call
    } finally {
      // Cleared on rejection too: a call that threw left nothing behind, so
      // the next identical one must really run rather than inherit the error.
      this.createCallsInFlight.delete(key)
    }
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
    if (pending.abandoned) {
      // ── LATE RECONCILIATION (#926) ──
      // The caller stopped waiting, but the renderer finished anyway. Dropping
      // this used to be how a real child became an orphan: created, placed in
      // the workspace, and unknown to the bridge, so the parent could neither
      // see it in list_agents nor close it. Adopting it here is what makes
      // "exactly one logical effect is discoverable" true.
      this.adoptLateResponse(response)
      return
    }
    pending.resolve(response)
  }

  /**
   * Take ownership of a response that arrived after its caller gave up.
   *
   * ── WHAT THIS IS AND IS NOT (#1077 review, 4) ──
   * Only main's OWN bookkeeping. An earlier version claimed a late child was
   * otherwise an "orphan the parent can neither see nor close"; review
   * disproved that — visibility and closability are decided in the RENDERER
   * from session metadata (`isVisibleToOrchestrationParent` over
   * `orchestrationParentId`), and `mergeClosedAgents` only appends tombstones.
   * A late child IS listable and closable without this.
   *
   * What is wrong without it is narrower and still worth fixing: main's
   * `promptDeliveries` and `parentSessionByChildSession` never learn the child
   * exists, so `enrichAgent` cannot report its delivery state and the parent's
   * status cache keeps a stale answer.
   */
  private adoptLateResponse(response: OrchestrationRendererResponse): void {
    if (!response.ok || response.type !== 'create-agent') return
    const parentSessionId = response.agent.orchestrationParentId
    this.promptDeliveries.set(response.agent.sessionId, {
      createdAt: Date.now(),
      promptSubmissionCount: 0,
    })
    this.parentSessionByChildSession.set(response.agent.sessionId, parentSessionId)
    this.closedAgents.delete(response.agent.sessionId)
    this.invalidateStatusCache(parentSessionId)
    this.journal?.recordIncident({
      kind: 'orchestration.late_response_adopted',
      severity: 'warn',
      reason: 'renderer_answered_after_timeout',
      context: {
        requestId: response.requestId,
        sessionId: response.agent.sessionId,
        parentSessionId,
        // The child exists and was never handed to the caller, so it is
        // running work nobody is waiting on. Worth an incident even though
        // recovery succeeded.
        bootstrapPromptDelivered: false,
      },
    })
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
      this.rendererQueue.push({ request, resolve, reject, finishQueue: mainOperations.begin('orchestration.queue') })
      this.drainRendererQueue()
    })
  }

  private drainRendererQueue(): void {
    while (
      this.activeRendererRequests < MAX_ACTIVE_RENDERER_REQUESTS &&
      this.rendererQueue.length > 0
    ) {
      const next = this.rendererQueue.shift()!
      next.finishQueue()
      const finishDispatch = mainOperations.begin('orchestration.dispatch')
      this.activeRendererRequests += 1
      void this.dispatchRendererRequest(next.request)
        .then(result => { finishDispatch(); next.resolve(result) }, error => { finishDispatch('error'); next.reject(error) })
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
        const mutating = MUTATING_REQUEST_TYPES.has(request.type)
        // The renderer never answered an orchestration request — JS thread
        // blocked, dead, or crashing mid-handler. Durable evidence of a hang
        // that the renderer itself can't report.
        this.journal?.recordIncident({
          kind: 'orchestration.request_timeout',
          severity: 'error',
          reason: 'renderer_no_response',
          context: { requestId: request.requestId, waitedMs: TIMEOUT_MS, requestType: request.type, mutating },
        })
        if (!mutating) {
          // A read changed nothing, so failing it is the whole truth and the
          // caller may simply ask again.
          this.pending.delete(request.requestId)
          reject(new Error('Timed out waiting for renderer orchestration response'))
          return
        }
        // ── A DISPATCHED MUTATION IS NOT A FAILED ONE (#926) ──
        // The request is sent BEFORE this timer starts, so it has definitely
        // crossed into the renderer. Keep the entry — marked abandoned — so a
        // late answer can still be reconciled, and hold a reservation so an
        // identical retry is refused rather than blindly duplicating.
        const entry = this.pending.get(request.requestId)
        if (entry) entry.abandoned = true
        reject(new OrchestrationOutcomeUnknownError(
          request.requestId,
          request.type,
          request.parentSessionId,
        ))
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
      // ── EXPIRED BEFORE DISPATCH IS NOT OUTCOME-UNKNOWN (#926) ──
      // `windowForSession` resolves through a lease check that deliberately
      // ignores `closing`, while delivery skips a closing window — so a
      // request could be silently dropped and then waited on for the full 30 s
      // before being reported as an unknown outcome. That is the worst
      // possible answer for the one case we can be CERTAIN about: nothing was
      // dispatched, so nothing happened, and retrying is not just safe but
      // correct. Review found this; the fix is to ask whether it was actually
      // delivered rather than assuming the send succeeded.
      if (!sendToWindow(target, 'orchestration:request', request)) {
        clearTimeout(timer)
        this.pending.delete(request.requestId)
        this.journal?.recordIncident({
          kind: 'orchestration.request_timeout',
          severity: 'warn',
          reason: 'renderer_unavailable',
          context: { requestId: request.requestId, requestType: request.type, dispatched: false },
        })
        reject(new Error(
          `The Agent Code window owning orchestration parent session ${request.parentSessionId} `
          + 'could not receive the request, so nothing was dispatched. It is safe to retry.',
        ))
        return
      }
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
    // A failed child that the parent has prompted AGAIN is waiting on that new
    // prompt, not failed (#1018): the stale failure would otherwise show until
    // the provider picked the prompt up.
    if (agent.lifecycleState === 'failed' && agent.failedAt && lastSubmittedAt && lastSubmittedAt > agent.failedAt) {
      return 'prompt_sent'
    }
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
