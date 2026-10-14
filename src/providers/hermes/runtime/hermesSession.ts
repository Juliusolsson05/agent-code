// HermesSession: an Agent Code agent backed by a REMOTE Hermes conversation
// (#1482, docs/decomposition/hermes-remote-chat.md).
//
// Unlike every other provider there is no process here at all: the agent
// runs on the user's VPS behind `hermes serve`. This class translates
// hermes-headless's channels onto the standard AgentSession events, so the
// app's existing machinery (SessionManager, the feed/ledger, conditions,
// Reader Mode, phone) treats a Hermes pane as an agent like any other:
//
//   hermes-headless                 →  AgentSession event
//   semantic 'event'                →  'semantic-event' (already fold vocabulary)
//   committed 'entry'               →  'jsonl-entry' (renderer mapper → Claude shape)
//   committed 'boundary'            →  'history-boundary' (resume, /new, rewrite)
//   screen 'activity'               →  'process-state'
//   'request' / 'request-closed'    →  'conditions' snapshot (hermes.* kinds)
//   'session' (stored id changed)   →  'provider-session-changed'
//   'connection'                    →  'input-readiness' + the reconnect loop
//
// It OWNS the reconnect loop, because only the app can decide when to redial
// (the dial needs a fresh ticket from main's token broker) and how hard to
// try. hermes-headless only knows how to resume on a new socket.

import { EventEmitter } from 'node:events'

import {
  HermesAuthError,
  HermesHeadless,
  HermesPromptError,
  type CommittedRow,
  type HermesConnectionState,
  type HermesRequest,
  type HermesSessionState,
  type HistoryBoundary,
  type ScreenActivityEvent,
  type SemanticEvent,
} from 'hermes-headless'

import { getHermesConnectionService } from '@main/hermes/registry.js'
import { hermesTranscriptSource, registerHermesHistory } from '@providers/hermes/runtime/hermesHistory.js'
import { HermesSignedOutError } from '@main/hermes/tokenBroker.js'
import { describeError } from '@main/hermes/service.js'
import type { ConditionAction, ConditionCustomAction } from '@shared/conditions-core/contract.js'
import type {
  HermesConditionKind,
  ProviderConditionRecord,
  ProviderConditionSnapshot,
} from '@shared/types/providerConditions.js'
import { HERMES_SIGNED_OUT_MESSAGE, HERMES_UNREACHABLE_MESSAGE, type AgentSession, type SessionOptions } from '@shared/types/session.js'
import {
  HERMES_ANSWER,
  HERMES_DECLINE,
  clarifyQuestions,
  validateAnswer,
} from '@providers/hermes/runtime/requestAnswers.js'

/** The `source` Agent Code tags committed rows with: one per conversation. */
export { hermesTranscriptSource }

/**
 * The jsonl-entry payload. The renderer's Hermes mapper turns it into the
 * Claude-shaped entries every shared consumer reads; `storedSessionId` is what
 * extractProviderSessionId returns.
 */
export type HermesEntryPayload = {
  hermes: 1
  key: string
  storedSessionId: string
  row: Record<string, unknown>
}

// Hermes Desktop's reconnect backoff (apps/shared/src/reconnect-backoff.ts):
// full jitter, 300 ms base, 15 s cap; a socket counts as stable after 5 s.
const BACKOFF_BASE_MS = 300
const BACKOFF_CAP_MS = 15_000
const STABLE_AFTER_MS = 5_000

const KIND_BY_METHOD: Record<HermesRequest['method'], HermesConditionKind> = {
  approval: 'hermes.approval',
  clarify: 'hermes.clarify',
  sudo: 'hermes.sudo',
  secret: 'hermes.secret',
}

const APPROVAL_LABELS: Record<string, string> = {
  once: 'Allow once',
  session: 'Allow for this chat',
  always: 'Always allow',
  deny: 'Deny',
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

export class HermesSession extends EventEmitter implements AgentSession {
  private headless: HermesHeadless | null = null
  private readonly connectionId: string
  private storedSessionId: string | null
  private stopped = false
  private exited = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private connectedAt = 0
  /** Open requests in arrival order; the card shows the oldest per kind. */
  private readonly openRequests: HermesRequest[] = []
  private noticeCounter = 0
  /**
   * The current conversation's rows as emitted, for a renderer that reloads
   * while this session lives (hermesHistory.ts). Reset with the history, so
   * it always equals what a fresh fold of this pane would show.
   */
  private committedRows: HermesEntryPayload[] = []
  private unregisterHistory: (() => void) | null = null
  private signedOut = false
  private readonly onServiceDisconnect = (id: string): void => {
    if (id !== this.connectionId || this.stopped || !this.headless) return
    // Stays detached: the socket closing below must not start the reconnect
    // loop, which would only redial a connection with no credentials.
    this.signedOut = true
    // Detach, never close: the conversation stays on the server and Reload
    // Agent resumes it once the user signs in again.
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    void this.headless.stop().catch(() => undefined)
    this.emit('input-readiness', { ready: false, reason: 'provider-not-ready' })
    this.emit('process-state', { active: false, status: 'Signed out of Hermes' })
    this.emitNotice(HERMES_SIGNED_OUT_MESSAGE)
  }
  /**
   * Offset for history generations. hermes-headless numbers generations from
   * 1 per instance, but a pane OUTLIVES its session: Reload Agent and recovery
   * build a new HermesSession for the same pane, and the renderer drops a
   * reset whose generation is not above the last it applied
   * (historyBoundary.ts decideHistoryBoundary). Without this offset the
   * reloaded pane's snapshot would be judged stale and the old conversation
   * left on screen. Wall-clock millis keep generations rising across lifetimes.
   */
  private readonly generationBase = Date.now() * 1000

  constructor(options: SessionOptions) {
    super()
    if (!options.remoteConnectionId) {
      throw new Error('A Hermes pane needs a connection. Add one in Settings → Hermes.')
    }
    this.connectionId = options.remoteConnectionId
    this.storedSessionId = options.resumeSessionId ?? null
  }

  async start(): Promise<{ projectDir?: string } | void> {
    this.emit('input-readiness', { ready: false, reason: this.storedSessionId ? 'replaying-history' : 'starting' })
    const service = getHermesConnectionService()
    const headless = new HermesHeadless({
      dial: service.dialFor(this.connectionId),
      target: this.storedSessionId
        ? { mode: 'resume', storedSessionId: this.storedSessionId }
        // `agent-code` marks our conversations in Hermes as self-owned
        // (any non-platform source; session_lifecycle.py) and lets Hermes
        // Desktop tell them apart (decomposition Unknown 3).
        : { mode: 'create', source: 'agent-code' },
    })
    this.headless = headless
    // Listeners BEFORE start(): the snapshot (history reset + rows + any open
    // approval) is emitted inside start(), exactly like OpenCode's resume
    // replay; attaching later would paint an empty pane.
    headless.semantic.on('event', (event: SemanticEvent) => this.emit('semantic-event', event))
    headless.committed.on('entry', (row: CommittedRow) => this.emitRow(row.key, row.storedSessionId, row.row as Record<string, unknown>))
    headless.committed.on('boundary', (boundary: HistoryBoundary) => this.emitBoundary(boundary))
    headless.committed.on('history_error', (error: Error) => this.emit('jsonl-error', error))
    headless.screen.on('activity', (activity: ScreenActivityEvent) => {
      this.emit('process-state', { active: activity.active, status: activity.status ?? undefined })
    })
    headless.on('session', (state: HermesSessionState) => this.onSession(state))
    headless.on('session-replaced', ({ previousStoredSessionId }: { previousStoredSessionId: string }) => {
      this.emitNotice(`The previous Hermes conversation (${previousStoredSessionId}) is gone from the server, so this pane started a new one.`)
    })
    headless.on('request', (request: HermesRequest) => this.onRequest(request))
    headless.on('request-closed', ({ id }: { id: string }) => this.onRequestClosed(id))
    headless.on('connection', (state: HermesConnectionState) => this.onConnection(state))
    service.on('disconnect', this.onServiceDisconnect)

    try {
      await headless.start()
    } catch (error) {
      service.off('disconnect', this.onServiceDisconnect)
      service.reportReachability(this.connectionId, false, error)
      this.exited = true
      // A failed start is a failed spawn: SessionManager rejects session:spawn
      // and the renderer launders the text (sessionSpawnErrorMessage). Only
      // the shared curated sentences survive that, so the two failures a
      // user can fix are mapped onto them; anything else keeps its detail
      // for main's journal and reaches the user as the generic failure.
      if (error instanceof HermesSignedOutError) throw new Error(HERMES_SIGNED_OUT_MESSAGE)
      if (error instanceof HermesAuthError && (error.kind === 'transport' || error.kind === 'unavailable')) {
        throw new Error(HERMES_UNREACHABLE_MESSAGE)
      }
      throw new Error(`Could not open the Hermes conversation: ${describeError(error)}`)
    }
    service.reportReachability(this.connectionId, true)
    this.emit('started', {})
    return {}
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.unregisterHistory?.()
    this.unregisterHistory = null
    getHermesConnectionService().off('disconnect', this.onServiceDisconnect)
    // Detach only: the conversation stays on the server and resumes on the
    // next spawn of this pane (hermes-headless stop() never session.close's).
    await this.headless?.stop().catch(() => undefined)
    this.exited = true
    this.emit('exit', { exitCode: 0 })
  }

  /** No PTY. Esc (the composer's stop key, and the phone's Stop) interrupts. */
  write(data: string): void {
    if (data === '\x1b') void this.headless?.interrupt().catch(() => undefined)
  }

  resize(): void {
    // Nothing to resize: the chat has no terminal grid.
  }

  isExited(): boolean {
    return this.exited
  }

  getProviderSessionId(): string | null {
    return this.storedSessionId
  }

  /**
   * The prompt path (registry deliverPrompt → this). A message starting with
   * `/` is a slash command: Hermes routes those itself (slash.exec /
   * command.dispatch), and printing output appears as a notice in the chat.
   */
  async deliverPromptText(text: string): Promise<void> {
    if (!this.headless) throw new HermesPromptError('not-ready', 'The Hermes conversation has not started.')
    if (/^\/[a-z0-9]/i.test(text.trim())) {
      const outcome = await this.headless.runSlash(text.trim())
      if (outcome.kind === 'output' && outcome.text.trim()) this.emitNotice(outcome.text.trim())
      if (outcome.kind === 'prefill') this.emitNotice(`Suggested message: ${outcome.text}`)
      return
    }
    await this.headless.prompt(text)
  }

  async resolveCondition(action: ConditionCustomAction): Promise<
    | { ok: true; state?: unknown }
    | { ok: false; reason: string; lastState?: unknown; failedAtStep?: string }
  > {
    if (!this.headless) return { ok: false, reason: 'no-headless' }
    const payload = asRecord(action.payload)
    const requestId = typeof payload?.requestId === 'string' ? payload.requestId : null
    // Answer only a request that is STILL open: a click racing Hermes'
    // timeout or an interrupt must not reply to a withdrawn request (the
    // OpenCode #1068 lesson: validate against the live record).
    const request = this.openRequests.find((entry) => entry.id === requestId)
    if (!request) return { ok: false, reason: 'invalid-payload' }
    try {
      if (action.name === HERMES_DECLINE) {
        await this.headless.declineRequest(request)
        return { ok: true }
      }
      if (action.name !== HERMES_ANSWER) return { ok: false, reason: 'no-resolver' }
      const result = validateAnswer(request, payload?.result)
      if (!result) return { ok: false, reason: 'invalid-payload' }
      await this.headless.answerRequest(request.id, result)
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: 'aborted', failedAtStep: `answer ${request.method}: ${describeError(error)}` }
    }
  }

  // ── events ─────────────────────────────────────────────────────────────────

  private emitRow(key: string, storedSessionId: string, row: Record<string, unknown>): void {
    const payload: HermesEntryPayload = { hermes: 1, key, storedSessionId, row }
    // Same key = the same row re-sent (a history refetch): replace in place.
    const index = this.committedRows.findIndex((entry) => entry.key === key)
    if (index >= 0) this.committedRows[index] = payload
    else this.committedRows.push(payload)
    this.emit('jsonl-entry', payload, hermesTranscriptSource(this.connectionId, storedSessionId))
  }

  /** A local, non-durable line in the chat (slash output, reconnect notes). */
  private emitNotice(text: string): void {
    const stored = this.storedSessionId ?? ''
    this.noticeCounter += 1
    this.emitRow(`notice:${Date.now()}:${this.noticeCounter}`, stored, { role: 'notice', text, timestamp: Date.now() / 1000 })
  }

  private emitBoundary(boundary: HistoryBoundary): void {
    if (boundary.type === 'reset') this.committedRows = []
    this.emit('history-boundary', {
      type: boundary.type,
      generation: this.generationBase + boundary.generation,
      snapshotByteLength: 0,
      complete: boundary.type === 'caught-up',
      file: hermesTranscriptSource(this.connectionId, this.storedSessionId ?? ''),
    })
  }

  private onSession(state: HermesSessionState): void {
    const previous = this.storedSessionId
    const changed = Boolean(state.storedSessionId && state.storedSessionId !== previous)
    // Register on the first session state too: a RESUMED pane starts with its
    // stored id already known, so "changed" alone would never register it.
    if (state.storedSessionId && (changed || !this.unregisterHistory) && !this.stopped) {
      this.unregisterHistory?.()
      this.unregisterHistory = registerHermesHistory(state.storedSessionId, {
        connectionId: this.connectionId,
        rows: () => this.committedRows,
      })
    }
    if (state.storedSessionId && changed) {
      this.storedSessionId = state.storedSessionId
      // A spawn with no stored id learns it here; `/new` and a missing-
      // conversation fallback CHANGE it. Either way the pane must rebind its
      // durable identity before the new conversation's rows arrive.
      this.emit('provider-session-changed', {
        providerSessionId: state.storedSessionId,
        transcriptFile: hermesTranscriptSource(this.connectionId, state.storedSessionId),
        reason: previous ? 'hermes-new-conversation' : 'hermes-created',
      })
    }
    const info = state.info
    if (info) getHermesConnectionService().reportBackend(this.connectionId, info.desktop_contract, typeof info.version === 'string' ? info.version : undefined)
  }

  private onConnection(state: HermesConnectionState): void {
    if (this.stopped || this.signedOut) return
    if (state.kind === 'ready') {
      this.connectedAt = Date.now()
      this.emit('input-readiness', { ready: true, reason: 'ready' })
      return
    }
    if (state.kind === 'disconnected') {
      this.emit('input-readiness', { ready: false, reason: 'provider-not-ready' })
      this.emit('process-state', { active: false, status: 'Reconnecting to Hermes…' })
      // A socket that lived less than STABLE_AFTER_MS was a failed attempt:
      // keep growing the backoff instead of hammering a flapping server.
      if (Date.now() - this.connectedAt > STABLE_AFTER_MS) this.attempt = 0
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** this.attempt)
    const delay = Math.random() * ceiling
    this.attempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.reconnect()
    }, delay)
  }

  private async reconnect(): Promise<void> {
    if (this.stopped || !this.headless) return
    const service = getHermesConnectionService()
    try {
      await this.headless.reconnect()
      service.reportReachability(this.connectionId, true)
    } catch (error) {
      if (error instanceof HermesSignedOutError) {
        // Retrying a dead sign-in forever would spin; the pane says what to do.
        this.emit('process-state', { active: false, status: 'Signed out of Hermes' })
        this.emitNotice('Signed out of this Hermes connection. Sign in again in Settings → Hermes, then use Reload Agent.')
        return
      }
      service.reportReachability(this.connectionId, false, error)
      this.scheduleReconnect()
    }
  }

  private onRequest(request: HermesRequest): void {
    if (this.openRequests.some((entry) => entry.id === request.id)) return
    this.openRequests.push(request)
    this.emitConditions()
  }

  private onRequestClosed(id: string): void {
    const index = this.openRequests.findIndex((entry) => entry.id === id)
    if (index < 0) return
    this.openRequests.splice(index, 1)
    this.emitConditions()
  }

  private emitConditions(): void {
    const conditions: Record<string, ProviderConditionRecord> = {}
    for (const method of Object.keys(KIND_BY_METHOD) as Array<HermesRequest['method']>) {
      const pending = this.openRequests.filter((request) => request.method === method)
      if (pending.length === 0) continue
      conditions[KIND_BY_METHOD[method]] = conditionRecord(pending[0], pending.length - 1)
    }
    const snapshot: ProviderConditionSnapshot = { provider: 'hermes', conditions, ts: Date.now() }
    this.emit('conditions', snapshot)
  }
}

function answerAction(requestId: string, id: string, label: string, result: unknown): ConditionCustomAction {
  return { kind: 'custom', id: `${requestId}:${id}`, label, name: HERMES_ANSWER, payload: { requestId, result } }
}

function declineAction(requestId: string, label: string): ConditionCustomAction {
  return { kind: 'custom', id: `${requestId}:decline`, label, name: HERMES_DECLINE, payload: { requestId } }
}


/**
 * The condition record for one request. Approval choices become plain
 * actions (one click). Clarify, sudo and secret need typed input, which is
 * view state: the view composes a HERMES_ANSWER payload and resolveCondition
 * validates it against THIS request (`validateAnswer`).
 */
export function conditionRecord(request: HermesRequest, queued: number): ProviderConditionRecord {
  const params = request.params
  switch (request.method) {
    case 'approval': {
      const offered = Array.isArray(params.choices) ? params.choices.filter((choice): choice is string => typeof choice === 'string') : ['once', 'deny']
      const actions: ConditionAction[] = offered.map((choice) =>
        choice === 'deny'
          ? declineAction(request.id, APPROVAL_LABELS.deny)
          : answerAction(request.id, choice, APPROVAL_LABELS[choice] ?? choice, { choice }))
      return {
        kind: 'hermes.approval',
        state: {
          visible: true,
          requestId: request.id,
          command: typeof params.command === 'string' ? params.command : '',
          description: typeof params.description === 'string' ? params.description : '',
          choices: offered,
          queued,
        },
        actions,
      }
    }
    case 'clarify': {
      const questions = clarifyQuestions(params)
      // A single single-choice question is the common case: one click.
      const actions: ConditionAction[] = questions.length === 1 && !questions[0].multiSelect
        ? questions[0].choices.map((choice) => answerAction(request.id, `choice:${choice}`, choice, { answers: { [questions[0].qid]: choice } }))
        : []
      actions.push(declineAction(request.id, 'Skip'))
      return { kind: 'hermes.clarify', state: { visible: true, requestId: request.id, questions, queued }, actions }
    }
    case 'sudo':
    case 'secret': {
      return {
        kind: KIND_BY_METHOD[request.method],
        state: {
          visible: true,
          requestId: request.id,
          prompt: request.method === 'sudo'
            ? (typeof params.command === 'string' ? params.command : '')
            : (typeof params.prompt === 'string' ? params.prompt : ''),
          envVar: request.method === 'secret' && typeof params.env_var === 'string' ? params.env_var : null,
          queued,
        },
        actions: [declineAction(request.id, 'Skip')],
      }
    }
  }
}
