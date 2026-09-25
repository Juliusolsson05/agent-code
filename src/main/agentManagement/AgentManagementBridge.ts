import { randomUUID } from 'node:crypto'

import {
  providerSessionLocator,
  transcriptLastModifiedAt as readTranscriptLastModifiedAt,
} from '@main/agentTranscripts/transcriptLocator.js'
import { sendToWindow, windowForSession } from '@main/window/windowRegistry.js'
import {
  findCodexRolloutPathsBySessionIds,
  resolveProviderTranscriptPath,
} from '@main/providerSwitch/shared.js'
import type { SessionManager } from '@main/sessionManager.js'
import type { AppRunJournal } from '@main/incident/AppRunJournal.js'
import type {
  AgentManagementRendererRequest,
  AgentManagementRendererResponse,
  ManagedAgentActivitySource,
  ManagedAgentProject,
  ManagedAgentRecord,
  ManagedAgentRendererDescriptor,
  ManagedAgentRendererOutput,
  ManagedAgentTarget,
  ManagedAgentTranscriptOutput,
} from '@mcp/shared/agentManagementTypes.js'

type PendingRequest = {
  resolve: (response: AgentManagementRendererResponse) => void
  timer: NodeJS.Timeout
  timedOut: boolean
  release: () => void
}

type QueuedRequest = {
  request: AgentManagementRendererRequest
  resolve: (response: AgentManagementRendererResponse) => void
  reject: (error: Error) => void
}

export type ManagedAgentListResult = {
  observedAt: number
  project: ManagedAgentProject
  agents: ManagedAgentRecord[]
}

export type ManagedAgentBulkReadResult = ManagedAgentListResult & {
  outputs: ManagedAgentTranscriptOutput[]
  unavailable: Array<{
    sessionId: string
    reason: 'transcript_unavailable' | 'not_created'
  }>
  truncated: boolean
  totalChars: number
}

type AgentManagementBridgeErrorCode =
  | Extract<AgentManagementRendererResponse, { ok: false }>['code']
  | 'prompt_delivery_uncertain'
  | 'renderer_unresponsive'

type AgentManagementBridgeErrorDetails = {
  sessionId?: string
  additionalAffectedSessionIds?: string[]
  retrySafe?: boolean
  disposition?: 'not-submitted' | 'outcome-unknown'
  promptSubmission?: 'not-submitted' | 'uncertain'
}

export class AgentManagementBridgeError extends Error {
  constructor(
    readonly code: AgentManagementBridgeErrorCode,
    message: string,
    readonly details: AgentManagementBridgeErrorDetails = {},
  ) {
    super(message)
    this.name = 'AgentManagementBridgeError'
  }
}

const REQUEST_TIMEOUT_MS = 30_000
const BULK_READ_TIMEOUT_MS = 120_000

export class AgentManagementBridge {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly queue: QueuedRequest[] = []
  private activeRequests = 0
  private timedOutRequestId: string | null = null

  constructor(
    private readonly manager: SessionManager,
    private readonly journal?: AppRunJournal,
  ) {}

  async listAgents(params: { callerSessionId: string }): Promise<ManagedAgentListResult> {
    const response = await this.request({
      requestId: randomUUID(),
      type: 'list-agents',
      ...params,
    })
    this.assertOk(response, 'list-agents')
    const agents = await this.enrichDescriptors(response.agents, response.observedAt)
    return { observedAt: response.observedAt, project: response.project, agents }
  }

  async readAgent(params: {
    callerSessionId: string
    target: ManagedAgentTarget
    maxMessages?: number
    maxCharsPerMessage?: number
    maxCharsPerAgent?: number
  }): Promise<ManagedAgentTranscriptOutput> {
    const response = await this.request({
      requestId: randomUUID(),
      type: 'read-agent',
      ...params,
    })
    this.assertOk(response, 'read-agent')
    const output = await this.enrichOutput(response.output, response.observedAt)
    if (
      output.messages.length === 0 &&
      output.agent.backendState !== 'live' &&
      output.agent.backendState !== 'spawning' &&
      output.agent.transcript.availability !== 'available'
    ) {
      throw new AgentManagementBridgeError(
        'transcript_unavailable',
        'No readable transcript evidence is currently available for the target.',
        { sessionId: output.agent.sessionId },
      )
    }
    return output
  }

  async readAgents(params: {
    callerSessionId: string
    sessionIds?: string[]
    labels?: string[]
    names?: string[]
    includeCaller?: boolean
    maxMessagesPerAgent?: number
    maxCharsPerMessage?: number
    maxCharsPerAgent?: number
    maxTotalChars?: number
  }): Promise<ManagedAgentBulkReadResult> {
    const response = await this.request({
      requestId: randomUUID(),
      type: 'read-agents',
      ...params,
    })
    this.assertOk(response, 'read-agents')

    // WHY the renderer returns one census beside the requested transcript
    // outputs: a cleanup audit needs stable project context even when only a
    // subset was read. Enrich each session once, then reuse the exact record in
    // both arrays so path/activity/backend facts cannot disagree within one MCP
    // response merely because a transcript file changed during serialization.
    const agents = await this.enrichDescriptors(response.agents, response.observedAt)
    const byId = new Map(agents.map(agent => [agent.sessionId, agent]))
    const outputs = await Promise.all(response.outputs.map(async item => {
      const known = byId.get(item.output.agent.sessionId)
      if (known) return { ...item.output, agent: known }
      return await this.enrichOutput(item, response.observedAt)
    }))
    const unavailableById = new Map(response.unavailable.map(item => [item.sessionId, item]))
    for (const output of outputs) {
      if (
        unavailableById.has(output.agent.sessionId) ||
        output.messages.length > 0 ||
        output.truncated ||
        output.agent.backendState === 'live' ||
        output.agent.backendState === 'spawning' ||
        output.agent.transcript.availability === 'available'
      ) continue
      // WHY an empty transcript row is not enough by itself to prove missing
      // history: a live, newly created process can truthfully have no messages,
      // and a budget-starved row is deliberately empty with truncated=true.
      // Only a parked empty row with no readable durable source is inferred
      // here; renderer-observed hydration failures arrive explicitly above.
      unavailableById.set(output.agent.sessionId, {
        sessionId: output.agent.sessionId,
        reason: output.agent.transcript.availability === 'not_created'
          ? 'not_created'
          : 'transcript_unavailable',
      })
    }
    return {
      observedAt: response.observedAt,
      project: response.project,
      agents,
      outputs,
      unavailable: [...unavailableById.values()],
      truncated: response.truncated,
      totalChars: response.totalChars,
    }
  }

  async sendPrompt(params: {
    callerSessionId: string
    target: ManagedAgentTarget
    prompt: string
  }): Promise<Pick<
    Extract<AgentManagementRendererResponse, { ok: true; type: 'send-prompt' }>,
    'sessionId' | 'displayLabel' | 'delivery'
  >> {
    let response: AgentManagementRendererResponse
    try {
      response = await this.request({
        requestId: randomUUID(),
        type: 'send-prompt',
        ...params,
      })
    } catch (error) {
      // Prompts/transcript text are intentionally absent from journal data.
      // The operational fact that delivery plumbing failed is enough for
      // diagnosing the bridge without turning the incident log into content
      // retention.
      this.journal?.record({
        area: 'mcp.agent_management',
        name: 'prompt_delivery.request_failed',
      })
      throw error
    }
    this.assertOk(response, 'send-prompt')
    if (!response.delivery.ok) {
      this.journal?.record({
        area: 'mcp.agent_management',
        name: 'prompt_delivery.failed',
        data: {
          stage: response.delivery.stage,
          code: response.delivery.code,
          disposition: response.delivery.disposition,
          retrySafe: response.delivery.retrySafe,
        },
      })
    }
    // The resolved identity travels back with the delivery (#1145): a caller
    // that addressed "B28" must be able to tell the user which agent that was.
    return {
      sessionId: response.sessionId,
      displayLabel: response.displayLabel,
      delivery: response.delivery,
    }
  }

  async closeAgent(params: {
    callerSessionId: string
    target: ManagedAgentTarget
  }): Promise<{ closedSessionId: string; displayLabel: string | null }> {
    // AUTHORIZATION LIVES IN THE RENDERER, at the line that mutates.
    //
    // The rule used to be prose in this tool's description — several sentences
    // telling the model never to close an agent unless the user's current
    // request named that specific agent. That is a request to a language model,
    // not a check: it cannot fail closed and cannot be tested.
    //
    // The first replacement was a single-use grant store here on the bridge.
    // Right instinct, wrong layer. A grant has to be ISSUED by a user action,
    // and main has no user action that means "the user asked this agent to
    // close that agent" — so nothing ever called `issueCloseGrant`, every
    // close_agent was denied, and the tool was dead in a way the green build
    // hid completely.
    //
    // The renderer's close gate CAN ask, because the user is there. The
    // close-agent handler passes `requireConfirmation`, which overrides the
    // idle-single exemption the policy grants a human pressing ⌘W — that
    // exemption is about someone aiming at a pane they can see, and none of it
    // transfers to a close a model decided to make. A declined dialog rejects
    // the request, and that rejection arrives here as a failed response.

    const response = await this.request({
      requestId: randomUUID(),
      type: 'close-agent',
      ...params,
    })
    this.assertOk(response, 'close-agent')
    return { closedSessionId: response.closedSessionId, displayLabel: response.displayLabel }
  }

  resolve(response: AgentManagementRendererResponse): void {
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(response.requestId)
    if (pending.timedOut) {
      // WHY a late response is useful even though its caller already received
      // an uncertainty error: it is the renderer's acknowledgement that the
      // serialized operation has actually stopped. Only now is it safe to let
      // a later close/send cross the same workspace mutation boundary.
      this.timedOutRequestId = null
      this.journal?.record({
        area: 'mcp.agent_management',
        name: 'renderer_request.recovered_after_timeout',
        data: { type: response.type },
      })
    } else {
      pending.resolve(response)
    }
    pending.release()
  }

  private assertOk<T extends AgentManagementRendererResponse['type']>(
    response: AgentManagementRendererResponse,
    expectedType: T,
  ): asserts response is Extract<AgentManagementRendererResponse, { ok: true; type: T }> {
    if (!response.ok) {
      throw new AgentManagementBridgeError(response.code, response.message, {
        ...(response.sessionId ? { sessionId: response.sessionId } : {}),
        ...(response.additionalAffectedSessionIds
          ? { additionalAffectedSessionIds: response.additionalAffectedSessionIds }
          : {}),
      })
    }
    if (response.type !== expectedType) {
      throw new Error(`Unexpected agent-management response: ${response.type}`)
    }
  }

  private request(
    request: AgentManagementRendererRequest,
  ): Promise<AgentManagementRendererResponse> {
    if (this.timedOutRequestId) {
      return Promise.reject(this.notDispatchedWhileRendererUnresponsive(request))
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ request, resolve, reject })
      this.pump()
    })
  }

  private pump(): void {
    if (this.activeRequests > 0) return
    const queued = this.queue.shift()
    if (!queued) return
    this.activeRequests += 1
    this.dispatch(queued)
  }

  private dispatch(queued: QueuedRequest): void {
    const { request } = queued
    // WHY fleet reads get a wider response window: their renderer operation
    // intentionally hydrates cold durable histories through a two-slot limiter.
    // Thirty seconds remains appropriate for one target and every mutation,
    // but it would turn a healthy large-project audit into a false renderer
    // outage merely because bounded I/O was doing exactly what we asked.
    const timeoutMs = request.type === 'read-agents' ? BULK_READ_TIMEOUT_MS : REQUEST_TIMEOUT_MS
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      this.activeRequests -= 1
      this.pump()
    }
    const timer = setTimeout(() => {
      const pending = this.pending.get(request.requestId)
      if (!pending) return
      pending.timedOut = true
      this.timedOutRequestId = request.requestId
      this.journal?.record({
        area: 'mcp.agent_management',
        name: 'renderer_request.timeout',
        data: { type: request.type },
      })
      queued.reject(this.rendererTimeoutError(request))

      // WHY queued calls fail immediately but the active slot remains held:
      // timing out only proves that main stopped waiting; it does not prove the
      // renderer stopped hydrating, waking, writing, or closing. Dispatching a
      // queued mutation now would break the bridge's serialization guarantee.
      // The late correlated response releases the slot. If it never arrives,
      // management stays fail-closed until the app recreates this bridge.
      for (const blocked of this.queue.splice(0)) {
        blocked.reject(this.notDispatchedWhileRendererUnresponsive(blocked.request))
      }
    }, timeoutMs)
    this.pending.set(request.requestId, {
      resolve: queued.resolve,
      timer,
      timedOut: false,
      release,
    })
    try {
      // WHY all requests are serialized even though list/read are logically
      // read-only: each crosses React's renderer-owned workspace model and bulk
      // reads may page durable history. Backpressure here prevents an MCP burst
      // from racing workspace mutations or starving the renderer event loop.
      //
      // WHY the caller's window is resolved here and a miss THROWS: the request
      // is answered from one window's workspace inventory, and this tool's whole
      // contract is that it reports the caller's project. Throwing inside this
      // try reuses the existing failure path (timer cleared, pending dropped,
      // slot released), which is exactly the fail-closed behavior the timeout
      // comment above describes.
      const target = windowForSession(request.callerSessionId)
      if (!target) {
        throw new Error(
          `No Agent Code window owns agent-management caller session ${request.callerSessionId}`,
        )
      }
      sendToWindow(target, 'agent-management:request', request)
    } catch (error) {
      clearTimeout(timer)
      this.pending.delete(request.requestId)
      queued.reject(error instanceof Error ? error : new Error(String(error)))
      release()
    }
  }

  private rendererTimeoutError(request: AgentManagementRendererRequest): Error {
    if (request.type === 'send-prompt') {
      return new AgentManagementBridgeError(
        'prompt_delivery_uncertain',
        'Prompt delivery timed out after dispatch. The outcome is unknown; do not retry automatically.',
        {
          ...targetDetails(request.target),
          retrySafe: false,
          disposition: 'outcome-unknown',
          promptSubmission: 'uncertain',
        },
      )
    }
    return new AgentManagementBridgeError(
      'renderer_unresponsive',
      `Agent-management renderer request timed out: ${request.type}`,
      'target' in request ? targetDetails(request.target) : {},
    )
  }

  private notDispatchedWhileRendererUnresponsive(
    request: AgentManagementRendererRequest,
  ): AgentManagementBridgeError {
    return new AgentManagementBridgeError(
      'renderer_unresponsive',
      'Agent Management is waiting for a timed-out renderer operation to finish; this request was not dispatched.',
      'target' in request
        ? {
            ...targetDetails(request.target),
            ...(request.type === 'send-prompt'
              ? {
                  retrySafe: true,
                  disposition: 'not-submitted' as const,
                  promptSubmission: 'not-submitted' as const,
                }
              : {}),
          }
        : {},
    )
  }

  private async enrichDescriptors(
    descriptors: ManagedAgentRendererDescriptor[],
    observedAt: number,
  ): Promise<ManagedAgentRecord[]> {
    const transcriptCache = new Map<string, Promise<string | null>>()
    const unresolvedCodex = descriptors.filter(descriptor => (
      descriptor.agent.kind === 'codex' &&
      descriptor.providerSessionId &&
      !this.manager.getTranscriptFile(descriptor.agent.sessionId)
    ))
    const codexPaths = await findCodexRolloutPathsBySessionIds(
      unresolvedCodex.flatMap(descriptor => descriptor.providerSessionId ?? []),
    )
    for (const descriptor of unresolvedCodex) {
      const providerSessionId = descriptor.providerSessionId!
      const key = this.transcriptCacheKey(descriptor, providerSessionId)
      transcriptCache.set(key, Promise.resolve(codexPaths.get(providerSessionId) ?? null))
    }
    const records: ManagedAgentRecord[] = []
    // WHY remaining enrichment is deliberately sequential: Codex's expensive
    // tree discovery was coalesced into the single walk above, but stat calls
    // and other providers' registry resolvers are still filesystem work. An
    // unbounded Promise.all across every pane would turn one fleet audit into a
    // disk burst; the bridge queue keeps the slower bounded path predictable.
    for (const descriptor of descriptors) {
      records.push(await this.enrichDescriptor(descriptor, observedAt, transcriptCache))
    }
    return records
  }

  private async enrichOutput(
    item: ManagedAgentRendererOutput,
    observedAt: number,
  ): Promise<ManagedAgentTranscriptOutput> {
    const descriptor: ManagedAgentRendererDescriptor = {
      agent: item.output.agent,
      ...(item.providerSessionId ? { providerSessionId: item.providerSessionId } : {}),
      // The renderer's activity answer has to survive this hop: dropping it
      // here is invisible, because `enrichDescriptor` would simply fall back
      // to whatever candidate it still has and publish A number.
      ...(item.lastActiveAt ? { lastActiveAt: item.lastActiveAt } : {}),
      ...(item.lastActiveSource ? { lastActiveSource: item.lastActiveSource } : {}),
    }
    const [agent] = await this.enrichDescriptors([descriptor], observedAt)
    if (!agent) throw new Error('Agent Management output lost its inventory record.')
    return { ...item.output, agent }
  }

  private async enrichDescriptor(
    descriptor: ManagedAgentRendererDescriptor,
    observedAt: number,
    transcriptCache: Map<string, Promise<string | null>>,
  ): Promise<ManagedAgentRecord> {
    const { agent } = descriptor
    const backend = this.manager.getBackendSnapshot(agent.sessionId)
    const backendActivityAt = this.manager.getLastActivityAt(agent.sessionId) ?? undefined
    let transcriptPath = agent.kind === 'codex'
      ? this.manager.getTranscriptFile(agent.sessionId)
      : await this.manager.resolveTranscriptFile(agent.sessionId)
    if (!transcriptPath && descriptor.providerSessionId) {
      const key = this.transcriptCacheKey(descriptor, descriptor.providerSessionId)
      let resolving = transcriptCache.get(key)
      if (!resolving) {
        // A provider without transcript files (OpenCode) is located by its
        // session id alone; file-backed providers resolve a path on disk.
        const locator = providerSessionLocator(agent.kind, descriptor.providerSessionId)
        resolving = locator !== null
          ? Promise.resolve(locator)
          : resolveProviderTranscriptPath({
              kind: agent.kind,
              cwd: agent.cwd,
              providerSessionId: descriptor.providerSessionId,
            }).catch(() => null)
        transcriptCache.set(key, resolving)
      }
      transcriptPath = await resolving
    }

    let transcriptLastModifiedAt: number | undefined
    if (transcriptPath) {
      // A provider may rotate/delete a transcript between path resolution and
      // this read, and an OpenCode session may be gone from its database.
      // Report it unavailable instead of publishing a stale locator as an
      // audit authority that subsequent reads cannot open.
      const modifiedAt = await readTranscriptLastModifiedAt(transcriptPath)
      if (modifiedAt === null) transcriptPath = null
      else transcriptLastModifiedAt = modifiedAt
    }
    // ── ONE RENDERER ANSWER, NOT TWO RAW FIELDS (#915) ──
    // This used to recombine `transcriptActivityAt` and `runtimeActivityAt`
    // itself, with a rule that differed from the TLDR peek footer's — so the
    // footer and this inventory could report different "last active" times for
    // the same agent. They diverged when the newest transcript entry carried no
    // visible text: the footer counted it, this did not.
    //
    // `descriptor.lastActiveAt` is now the renderer's single answer, shared
    // with the footer through `sessionActivity`, and it brings its own source
    // label. WHY the label travels instead of being assigned here: this side
    // sees one number and can only say where it arrived from, so labelling it
    // `'runtime'` published a JSONL watermark — a real transcript record — as
    // though it were a clock. `lastActivitySource` is cited as evidence by an
    // auditing agent, so the citation has to be true (review of #1080).
    //
    // The other two candidates are main-side clocks the renderer does not
    // have. They are NOT both "evidence the renderer cannot see", as an
    // earlier version of this comment claimed:
    //   - `transcriptLastModifiedAt` is a real stat of the file, genuinely
    //     out of the renderer's reach;
    //   - `backendActivityAt` is `SessionManager.markActivity`, a wall-clock
    //     `Date.now()` fired from pty-data, screen frames, jsonl entries,
    //     process state and more — all of which are also relayed to the
    //     renderer. It IS a second opinion about the same facts, and a weak
    //     one: the screen stamp is taken BEFORE the frame gate that exists
    //     because most consecutive frames differ only in spinner chrome. It
    //     stays because it is the only signal for a pane whose renderer
    //     runtime was never hydrated, and `lastActivitySource: 'backend'` is
    //     what tells a reader the answer rests on it. Narrowing it to the
    //     signals the design doc counts is its own change, not this one's.
    const activityCandidates = [
      { value: transcriptLastModifiedAt, source: 'transcript' as const },
      { value: descriptor.lastActiveAt, source: descriptor.lastActiveSource ?? 'runtime' },
      { value: backendActivityAt, source: 'backend' as const },
    ].filter((item): item is { value: number; source: ManagedAgentActivitySource } => (
      typeof item.value === 'number' && Number.isFinite(item.value)
    ))
    activityCandidates.sort((a, b) => b.value - a.value)
    const latest = activityCandidates[0]

    return {
      ...agent,
      backendState: backend?.lifecycle === 'live'
        ? 'live'
        : backend?.lifecycle === 'spawning'
          ? 'spawning'
          // Main owns provider-process lifetime. A restored renderer runtime
          // can still carry yesterday's `started` flags after the backend is
          // gone; retaining that optimistic value would tell cleanup audits a
          // hibernated agent is live. Preserve only a renderer-observed failure
          // (main has no durable failed snapshot), otherwise absence means
          // hibernated.
          : agent.backendState === 'failed'
            ? 'failed'
            : 'hibernated',
      transcript: transcriptPath
        ? {
            path: transcriptPath,
            availability: 'available',
            ...(transcriptLastModifiedAt ? { lastModifiedAt: transcriptLastModifiedAt } : {}),
          }
        : {
            path: null,
            availability: descriptor.providerSessionId ? 'unavailable' : 'not_created',
          },
      ...(latest
        ? {
            lastActivityAt: latest.value,
            lastActivitySource: latest.source,
            idleForMs: Math.max(0, observedAt - latest.value),
          }
        : {}),
    }
  }

  private transcriptCacheKey(
    descriptor: ManagedAgentRendererDescriptor,
    providerSessionId: string,
  ): string {
    return `${descriptor.agent.kind}\u0000${descriptor.agent.cwd}\u0000${providerSessionId}`
  }
}

/**
 * What a main-side failure can say about the target (#1145).
 *
 * WHY only a sessionId is ever reported: main never resolves labels or names
 * (only the renderer has the row stream), so when a request dies in transit
 * the one identity main can vouch for is an id the caller passed itself.
 * Echoing an unresolved "B28" as `sessionId` would be a fabricated identity.
 */
function targetDetails(target: ManagedAgentTarget): { sessionId?: string } {
  return target.sessionId ? { sessionId: target.sessionId } : {}
}
