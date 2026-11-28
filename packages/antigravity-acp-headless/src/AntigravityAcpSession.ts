// One Antigravity conversation driven over the Agent Client Protocol.
//
// WHY ACP and not the agy TUI in a PTY (the Claude/Codex/Grok shape): agy
// keeps its conversations in a private SQLite store
// (~/.gemini/antigravity-cli/conversations/<id>.db) whose schema is
// undocumented, so there is no durable transcript to tail, and the TUI has no
// hook or socket a host could observe. `agy acp` is agy's own supported
// integration surface (ACP, the open Agent Client Protocol): structured text
// and tool streams, permission requests the client answers, `session/load`
// to replay a conversation, `session/list` for the catalog, and MCP servers
// handed over per session. Everything below was recorded against agy 1.5.15
// with a personal Google AI Ultra login.
//
// Owner rule (shared with every headless package here): this class never
// spawns or kills a process. The app starts `agy acp` and hands over its
// stdio; stop() only closes the protocol.

import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'

import { AcpConnection, AcpError, type AcpIncomingRequest } from './acp/AcpConnection.js'
import { TurnAssembler, type AntigravityRow, type AntigravitySemanticEvent } from './transcript/assembler.js'

export const ANTIGRAVITY_PERMISSION_KIND = 'antigravity.permission'

export type AntigravityMcpServer =
  | { type: 'http'; name: string; url: string; headers: Array<{ name: string; value: string }> }
  | { type: 'stdio'; name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }

export type AntigravityPermissionOption = { optionId: string; name: string; kind: string }

export type AntigravityPermissionRequest = {
  /** Our key for the pending request (the agent's JSON-RPC id, stringified). */
  requestKey: string
  toolCallId: string | null
  title: string
  toolName: string | null
  toolKind: string | null
  input: unknown
  options: AntigravityPermissionOption[]
  receivedAt: number
}

export type AntigravityActivity = { active: boolean; status: 'starting' | 'idle' | 'working' | 'waiting-permission' | 'exited' }

export type AntigravityConditionSnapshot = {
  provider: 'antigravity'
  conditions: Record<string, { kind: string; state: unknown; actions: unknown[] }>
  ts: number
}

export type AntigravitySessionEvents = {
  /** A committed row (also re-sent with the same key never happens: rows are immutable). */
  row: [AntigravityRow]
  /** reset = everything before belongs to another conversation or is replaced. */
  history: [{ kind: 'reset' | 'caught-up'; conversationChanged: boolean }]
  semantic: [AntigravitySemanticEvent]
  activity: [AntigravityActivity]
  conditions: [AntigravityConditionSnapshot]
  /** agy's generated conversation title. */
  title: [string]
  usage: [{ used: number; size: number }]
  ready: [{ sessionId: string; resumed: boolean; models: unknown }]
  error: [{ code: string; message: string }]
  closed: [{ reason: string }]
}

export interface AntigravityAcpSession {
  on<K extends keyof AntigravitySessionEvents>(event: K, listener: (...args: AntigravitySessionEvents[K]) => void): this
  off<K extends keyof AntigravitySessionEvents>(event: K, listener: (...args: AntigravitySessionEvents[K]) => void): this
  once<K extends keyof AntigravitySessionEvents>(event: K, listener: (...args: AntigravitySessionEvents[K]) => void): this
  emit<K extends keyof AntigravitySessionEvents>(event: K, ...args: AntigravitySessionEvents[K]): boolean
}

export type AntigravityAcpSessionOptions = {
  input: Readable
  output: Writable
  cwd: string
  /** Resume this conversation (session/load); absent = a new one (session/new). */
  resumeSessionId?: string | null
  mcpServers?: readonly AntigravityMcpServer[]
  /** Model id for session/set_model (e.g. `gemini-4-neon-high`), optional. */
  model?: string | null
  clientInfo?: { name: string; version: string }
  now?: () => number
  /** How long agy gets to honour session/cancel before the turn is failed locally. */
  cancelGraceMs?: number
}

export class AntigravityPromptError extends Error {
  constructor(readonly code: 'not-ready' | 'closed' | 'rejected', message: string) {
    super(message)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export class AntigravityAcpSession extends EventEmitter {
  private readonly connection: AcpConnection
  private readonly assembler: TurnAssembler
  private readonly now: () => number
  private sessionId: string | null = null
  private started = false
  private closed = false
  private turnActive = false
  private promptImages = false

  get acceptsImages(): boolean { return this.promptImages }
  private readonly rows: AntigravityRow[] = []
  private readonly permissions = new Map<string, { request: AcpIncomingRequest; info: AntigravityPermissionRequest }>()
  private activity: AntigravityActivity = { active: false, status: 'starting' }
  private holdingRows = false
  private abandonTurn: ((error: Error) => void) | null = null
  private cancelTimer: ReturnType<typeof setTimeout> | null = null
  private readonly cancelGraceMs: number
  private turnQueue: Promise<void> = Promise.resolve()

  constructor(private readonly options: AntigravityAcpSessionOptions) {
    super()
    this.now = options.now ?? Date.now
    this.cancelGraceMs = options.cancelGraceMs ?? 10_000
    this.assembler = new TurnAssembler('', {
      row: row => this.storeRow(row),
      semantic: event => this.emit('semantic', event),
    }, this.now)
    this.connection = new AcpConnection(options.input, options.output, {
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: request => this.onRequest(request),
      onClose: reason => this.onClose(reason),
    })
  }

  getSessionId(): string | null {
    return this.sessionId
  }

  /** Every committed row of this conversation, in conversation order. */
  getRows(): readonly AntigravityRow[] {
    return this.rows
  }

  getActivity(): AntigravityActivity {
    return { ...this.activity }
  }

  isTurnActive(): boolean {
    return this.turnActive
  }

  async start(): Promise<{ sessionId: string; resumed: boolean }> {
    if (this.started) throw new Error('AntigravityAcpSession already started')
    this.started = true
    const init = await this.connection.request('initialize', {
      protocolVersion: 1,
      // No fs or terminal capability: agy then uses its own file and shell
      // tools, which is what its permission rules and sandbox are built for.
      // Offering ours would route every file read through Agent Code.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: this.options.clientInfo ?? { name: 'agent-code', version: '0' },
    }, 60_000)
    if (!isRecord(init) || init.protocolVersion !== 1) {
      throw new AcpError('protocol', 'agy acp answered initialize with an unsupported protocol version')
    }

    const caps = init.agentCapabilities
    this.promptImages = isRecord(caps) && isRecord(caps.promptCapabilities) && caps.promptCapabilities.image === true

    const mcpServers = [...(this.options.mcpServers ?? [])]
    const resumeId = this.options.resumeSessionId ?? null
    let result: unknown
    let resumed = false
    if (resumeId) {
      // session/load replays the whole conversation as session/update
      // notifications BEFORE its response arrives. The replayed rows are
      // HELD until the load succeeds: publishing the reset first and then
      // failing would leave the pane wiped (review finding).
      this.sessionId = resumeId
      this.assembler.reset(resumeId)
      this.assembler.setLive(false)
      this.holdingRows = true
      try {
        result = await this.connection.request('session/load', { sessionId: resumeId, cwd: this.options.cwd, mcpServers }, 120_000)
        this.assembler.flush()
        resumed = true
      } catch (error) {
        // A closed connection is fatal; anything agy ANSWERED (unknown or
        // deleted conversation) falls back to a new conversation below.
        if (!(error instanceof AcpError) || error.code !== 'remote') throw error
        this.rows.length = 0
      } finally {
        this.holdingRows = false
      }
      if (resumed) {
        this.emit('history', { kind: 'reset', conversationChanged: false })
        for (const row of this.rows) this.emit('row', row)
        this.emit('history', { kind: 'caught-up', conversationChanged: false })
      }
    }
    if (!resumed) {
      result = await this.connection.request('session/new', { cwd: this.options.cwd, mcpServers }, 120_000)
      const sessionId = isRecord(result) && typeof result.sessionId === 'string' ? result.sessionId : null
      if (!sessionId) throw new AcpError('protocol', 'agy acp did not return a session id')
      this.sessionId = sessionId
      this.assembler.reset(sessionId)
      if (resumeId) {
        // The pane still shows the conversation it asked for; this is a
        // DIFFERENT one, so its rows and live turns must go (conversationChanged).
        this.emit('history', { kind: 'reset', conversationChanged: true })
        this.emit('history', { kind: 'caught-up', conversationChanged: false })
      }
    }
    this.assembler.setLive(true)

    if (this.options.model) {
      // Best effort: an unknown model id must not make the pane unusable.
      await this.connection.request('session/set_model', { sessionId: this.sessionId, modelId: this.options.model }, 30_000)
        .catch(error => this.emit('error', { code: 'set-model-failed', message: (error as Error).message }))
    }
    this.setActivity({ active: false, status: 'idle' })
    this.emit('ready', { sessionId: this.sessionId!, resumed, models: isRecord(result) ? result.models : undefined })
    return { sessionId: this.sessionId!, resumed }
  }

  /**
   * Run one prompt. Resolves with ACP's stop reason when the TURN ends.
   *
   * `accepted` resolves when the session/prompt request is WRITTEN to agy —
   * at once when idle, or only when the running turn ends for a queued
   * prompt (callers that must not wait, like AntigravitySession, check
   * isTurnActive() first). Esc cancels only the running turn; a queued
   * prompt still runs after it, as in agy's own TUI.
   *
   * WHY prompts are queued, not refused, during a turn: ACP allows one
   * session/prompt at a time per session; a prompt typed during a turn should
   * run after it, as it would in agy's own TUI queue.
   */
  prompt(text: string, images: readonly { type: 'image'; mimeType: string; data: string }[] = []): { accepted: Promise<void>; finished: Promise<string | null> } {
    if (images.length && !this.promptImages) {
      const error = new AntigravityPromptError('rejected', 'agy does not advertise image prompts')
      return { accepted: Promise.reject(error), finished: Promise.reject(error) }
    }
    if (this.closed || !this.sessionId) {
      const error = new AntigravityPromptError(this.closed ? 'closed' : 'not-ready', this.closed ? 'agy has stopped' : 'agy is not ready yet')
      return { accepted: Promise.reject(error), finished: Promise.reject(error) }
    }
    let accept!: () => void
    let refuse!: (error: Error) => void
    const accepted = new Promise<void>((resolve, reject) => {
      accept = resolve
      refuse = reject
    })
    const finished = this.turnQueue.then(async () => {
      if (this.closed) {
        const error = new AntigravityPromptError('closed', 'agy has stopped')
        refuse(error)
        throw error
      }
      this.turnActive = true
      this.assembler.beginTurn(images.length && !text.trim() ? '[Image attached]' : text)
      this.setActivity({ active: true, status: 'working' })
      const request = this.connection.request('session/prompt', { sessionId: this.sessionId, prompt: [...(text ? [{ type: 'text', text }] : []), ...images] }, null)
      accept()
      // Settled early only when agy ignores a cancel (see cancel()).
      const abandoned = new Promise<never>((_, reject) => {
        this.abandonTurn = reject
      })
      try {
        const result = await Promise.race([request, abandoned])
        const stopReason = isRecord(result) && typeof result.stopReason === 'string' ? result.stopReason : null
        this.assembler.endTurn(stopReason)
        return stopReason
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.assembler.failTurn(message)
        this.emit('error', { code: 'prompt-failed', message })
        throw new AntigravityPromptError('rejected', message)
      } finally {
        this.abandonTurn = null
        if (this.cancelTimer) clearTimeout(this.cancelTimer)
        this.cancelTimer = null
        this.turnActive = false
        this.clearPermissions('cancelled')
        if (!this.closed) this.setActivity({ active: false, status: 'idle' })
      }
    })
    // The queue must survive a failed turn.
    this.turnQueue = finished.then(() => undefined, () => undefined)
    return { accepted, finished }
  }

  /**
   * Stop the running turn (the app's Esc). Pending permission asks are
   * cancelled too.
   *
   * WHY a deadline: session/cancel is a notification, and an agy stuck in a
   * tool can ignore it. The prompt request has no timeout (turns can run for
   * hours), so without this the turn — and every prompt queued behind it —
   * would never settle until the pane was killed. After the grace period the
   * turn is failed locally; agy may still answer later, which is ignored.
   */
  cancel(): void {
    if (!this.sessionId || !this.turnActive) return
    this.clearPermissions('cancelled')
    this.connection.notify('session/cancel', { sessionId: this.sessionId })
    if (this.cancelTimer) return
    this.cancelTimer = setTimeout(() => {
      this.cancelTimer = null
      this.abandonTurn?.(new AntigravityPromptError('rejected', 'agy did not stop the turn after a cancel; reload the agent if it stays stuck.'))
    }, this.cancelGraceMs)
    this.cancelTimer.unref?.()
  }

  /** Answer an open permission request with one of ITS options. */
  respondPermission(requestKey: string, optionId: string): boolean {
    const pending = this.permissions.get(requestKey)
    if (!pending || !pending.info.options.some(option => option.optionId === optionId)) return false
    this.permissions.delete(requestKey)
    this.connection.respond(pending.request.id, { outcome: { outcome: 'selected', optionId } })
    this.afterPermissionChange()
    return true
  }

  getPermissions(): AntigravityPermissionRequest[] {
    return [...this.permissions.values()].map(entry => entry.info)
  }

  async stop(): Promise<void> {
    if (this.closed) return
    this.clearPermissions('cancelled')
    this.connection.close('stopped')
  }

  // ── protocol ──────────────────────────────────────────────────────────────

  private onNotification(method: string, params: unknown): void {
    if (method !== 'session/update' || !isRecord(params) || !isRecord(params.update)) return
    if (this.sessionId && typeof params.sessionId === 'string' && params.sessionId !== this.sessionId) return
    const update = params.update
    switch (update.sessionUpdate) {
      case 'session_info_update':
        if (typeof update.title === 'string' && update.title.trim()) this.emit('title', update.title.trim())
        return
      case 'usage_update':
        if (typeof update.used === 'number' && typeof update.size === 'number') this.emit('usage', { used: update.used, size: update.size })
        return
      default:
        this.assembler.apply(update)
    }
  }

  private onRequest(request: AcpIncomingRequest): void {
    if (request.method === 'session/request_permission' && isRecord(request.params)) {
      const params = request.params
      const toolCall = isRecord(params.toolCall) ? params.toolCall : {}
      // Keep the tool's live row in step (status pending → in_progress …).
      if (typeof toolCall.toolCallId === 'string') this.assembler.apply({ ...toolCall, sessionUpdate: 'tool_call_update' })
      const options = (Array.isArray(params.options) ? params.options : [])
        .filter(isRecord)
        .filter(option => typeof option.optionId === 'string')
        .map(option => ({ optionId: option.optionId as string, name: typeof option.name === 'string' ? option.name : String(option.optionId), kind: typeof option.kind === 'string' ? option.kind : 'other' }))
      const requestKey = String(request.id)
      this.permissions.set(requestKey, {
        request,
        info: {
          requestKey,
          toolCallId: typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : null,
          title: typeof toolCall.title === 'string' ? toolCall.title : 'Tool permission',
          toolName: typeof toolCall.name === 'string' ? toolCall.name : null,
          toolKind: typeof toolCall.kind === 'string' ? toolCall.kind : null,
          input: toolCall.rawInput ?? toolCall.args ?? null,
          options,
          receivedAt: this.now(),
        },
      })
      this.afterPermissionChange()
      return
    }
    // We advertised no fs or terminal capability; anything else is a method
    // this client does not implement, and saying so beats a silent hang.
    this.connection.respondError(request.id, -32601, `Method not supported by Agent Code: ${request.method}`)
  }

  private clearPermissions(outcome: 'cancelled'): void {
    if (this.permissions.size === 0) return
    for (const { request } of this.permissions.values()) this.connection.respond(request.id, { outcome: { outcome } })
    this.permissions.clear()
    this.afterPermissionChange()
  }

  private afterPermissionChange(): void {
    const waiting = this.permissions.size > 0
    if (this.turnActive) this.setActivity({ active: true, status: waiting ? 'waiting-permission' : 'working' })
    const conditions: AntigravityConditionSnapshot['conditions'] = {}
    // One condition at a time, oldest first: agy asks for one tool at a time
    // in practice, and the outlet shows one card.
    const first = [...this.permissions.values()][0]?.info
    if (first) {
      conditions[ANTIGRAVITY_PERMISSION_KIND] = {
        kind: ANTIGRAVITY_PERMISSION_KIND,
        state: { visible: true, ...first, queued: this.permissions.size - 1 },
        actions: first.options.map(option => ({
          kind: 'custom',
          id: `${first.requestKey}:${option.optionId}`,
          label: option.name,
          name: 'antigravity.permission.respond',
          payload: { requestKey: first.requestKey, optionId: option.optionId },
        })),
      }
    }
    this.emit('conditions', { provider: 'antigravity', conditions, ts: this.now() })
  }

  private storeRow(row: AntigravityRow): void {
    // Rows can close out of ordinal order (a tool commits when it finishes,
    // after text that started later); history must stay in conversation order.
    let index = this.rows.length
    while (index > 0 && this.rows[index - 1]!.ordinal > row.ordinal) index -= 1
    this.rows.splice(index, 0, row)
    if (!this.holdingRows) this.emit('row', row)
  }

  private setActivity(next: AntigravityActivity): void {
    if (next.active === this.activity.active && next.status === this.activity.status) return
    this.activity = next
    this.emit('activity', { ...next })
  }

  private onClose(reason: string): void {
    if (this.closed) return
    this.closed = true
    if (this.cancelTimer) clearTimeout(this.cancelTimer)
    this.cancelTimer = null
    const hadPermissions = this.permissions.size > 0
    this.permissions.clear()
    if (hadPermissions) {
      this.emit('conditions', { provider: 'antigravity', conditions: {}, ts: this.now() })
    }
    this.setActivity({ active: false, status: 'exited' })
    this.emit('closed', { reason })
  }
}
