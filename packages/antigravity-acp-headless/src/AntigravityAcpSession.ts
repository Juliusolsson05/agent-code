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
  private readonly rows: AntigravityRow[] = []
  private readonly permissions = new Map<string, { request: AcpIncomingRequest; info: AntigravityPermissionRequest }>()
  private activity: AntigravityActivity = { active: false, status: 'starting' }
  private turnQueue: Promise<void> = Promise.resolve()

  constructor(private readonly options: AntigravityAcpSessionOptions) {
    super()
    this.now = options.now ?? Date.now
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

    const mcpServers = [...(this.options.mcpServers ?? [])]
    const resumeId = this.options.resumeSessionId ?? null
    let result: unknown
    if (resumeId) {
      // session/load replays the whole conversation as session/update
      // notifications BEFORE its response arrives; they fold into rows only.
      this.sessionId = resumeId
      this.assembler.reset(resumeId)
      this.assembler.setLive(false)
      this.emit('history', { kind: 'reset', conversationChanged: false })
      try {
        result = await this.connection.request('session/load', { sessionId: resumeId, cwd: this.options.cwd, mcpServers }, 120_000)
      } finally {
        this.assembler.flush()
      }
      this.emit('history', { kind: 'caught-up', conversationChanged: false })
    } else {
      result = await this.connection.request('session/new', { cwd: this.options.cwd, mcpServers }, 120_000)
      const sessionId = isRecord(result) && typeof result.sessionId === 'string' ? result.sessionId : null
      if (!sessionId) throw new AcpError('protocol', 'agy acp did not return a session id')
      this.sessionId = sessionId
      this.assembler.reset(sessionId)
    }
    this.assembler.setLive(true)

    if (this.options.model) {
      // Best effort: an unknown model id must not make the pane unusable.
      await this.connection.request('session/set_model', { sessionId: this.sessionId, modelId: this.options.model }, 30_000)
        .catch(error => this.emit('error', { code: 'set-model-failed', message: (error as Error).message }))
    }
    this.setActivity({ active: false, status: 'idle' })
    this.emit('ready', { sessionId: this.sessionId!, resumed: Boolean(resumeId), models: isRecord(result) ? result.models : undefined })
    return { sessionId: this.sessionId!, resumed: Boolean(resumeId) }
  }

  /**
   * Run one prompt. Resolves with ACP's stop reason when the TURN ends.
   *
   * `accepted` resolves as soon as the prompt has been handed to agy (the
   * request is written in order behind any running turn) — that is the
   * delivery acknowledgement callers need, not the end of the turn.
   *
   * WHY prompts are queued, not refused, during a turn: ACP allows one
   * session/prompt at a time per session; a prompt typed during a turn should
   * run after it, as it would in agy's own TUI queue.
   */
  prompt(text: string): { accepted: Promise<void>; finished: Promise<string | null> } {
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
      this.assembler.beginTurn(text)
      this.setActivity({ active: true, status: 'working' })
      const request = this.connection.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] }, null)
      accept()
      try {
        const result = await request
        const stopReason = isRecord(result) && typeof result.stopReason === 'string' ? result.stopReason : null
        this.assembler.endTurn(stopReason)
        return stopReason
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.assembler.failTurn(message)
        this.emit('error', { code: 'prompt-failed', message })
        throw new AntigravityPromptError('rejected', message)
      } finally {
        this.turnActive = false
        this.clearPermissions('cancelled')
        if (!this.closed) this.setActivity({ active: false, status: 'idle' })
      }
    })
    // The queue must survive a failed turn.
    this.turnQueue = finished.then(() => undefined, () => undefined)
    return { accepted, finished }
  }

  /** Stop the running turn (the app's Esc). Pending permission asks are cancelled too. */
  cancel(): void {
    if (!this.sessionId || !this.turnActive) return
    this.clearPermissions('cancelled')
    this.connection.notify('session/cancel', { sessionId: this.sessionId })
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
    this.emit('row', row)
  }

  private setActivity(next: AntigravityActivity): void {
    if (next.active === this.activity.active && next.status === this.activity.status) return
    this.activity = next
    this.emit('activity', { ...next })
  }

  private onClose(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.permissions.clear()
    this.setActivity({ active: false, status: 'exited' })
    this.emit('closed', { reason })
  }
}
