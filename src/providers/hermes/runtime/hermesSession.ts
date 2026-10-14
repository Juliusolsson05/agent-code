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
  HermesHeadless,
  HermesPromptError,
  type CommittedRow,
  type HermesConnectionState,
  type HermesRequest,
  type HermesLaneState,
  type HermesNotice,
  type LaneMove,
  type HermesSessionState,
  type HermesSideAnswer,
  type HistoryBoundary,
  type ScreenActivityEvent,
  type SemanticEvent,
} from 'hermes-headless'

import { getHermesConnectionService } from '@main/hermes/registry.js'
import { hermesTranscriptSource, registerHermesHistory } from '@providers/hermes/runtime/hermesHistory.js'
import { HermesSignedOutError } from '@main/hermes/tokenBroker.js'
import { describeError, HermesConnectionMissingError, type HermesDisconnectReason } from '@main/hermes/service.js'
import type { ConditionAction, ConditionCustomAction } from '@shared/conditions-core/contract.js'
import type {
  HermesConditionKind,
  ProviderConditionRecord,
  ProviderConditionSnapshot,
} from '@shared/types/providerConditions.js'
import { HERMES_SIGNED_OUT_MESSAGE, type AgentSession, type SessionOptions } from '@shared/types/session.js'
import { classifyHermesStartFailure } from '@providers/hermes/runtime/startFailure.js'
import { toolResultCacheFor } from '@providers/hermes/runtime/toolResultCache.js'
import { composerCommandsFromCatalog, findComposerCommand } from '@providers/hermes/runtime/composerCommands.js'
import type { ComposerCommand } from '@shared/composerCommands/types.js'
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

// /restart: wait before the first status check (the old gateway may still be
// up), then poll; Hermes' own restart takes about a minute in the owner's
// Docker deployment.
const RESTART_SETTLE_MS = 5_000
const RESTART_POLL_MS = 2_000
const RESTART_DEADLINE_MS = 90_000

/** Before the catalog arrives: what Agent Code handles or refuses on its own. */
const HERMES_APP_COMMANDS_WITH_REFUSALS: ComposerCommand[] = composerCommandsFromCatalog({})

// Hermes Desktop's reconnect backoff (apps/shared/src/reconnect-backoff.ts):
// full jitter, 300 ms base, 15 s cap; a socket counts as stable after 5 s.
const BACKOFF_BASE_MS = 300
const BACKOFF_CAP_MS = 15_000
const STABLE_AFTER_MS = 5_000

// Actions on the held-prompt card (Telegram-thread mode).
const HERMES_HELD_SEND = 'hermes.held.send'
const HERMES_HELD_CANCEL = 'hermes.held.cancel'

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
  /** When each live request arrived (sudo/secret countdown). */
  private readonly requestReceivedAt = new Map<string, number>()
  /** Telegram-thread mode (#1496): the gateway routing key this pane follows. */
  private readonly laneKey: string | null
  /** Prompts held behind a running phone turn (hermes-headless lane state). */
  private held: Array<{ id: string; text: string }> = []
  private laneNoticeShown = false
  /** commands.catalog for this attach (listComposerCommands). */
  private composerCommands: ComposerCommand[] | null = null
  /**
   * The current conversation's rows as emitted, for a renderer that reloads
   * while this session lives (hermesHistory.ts). Reset with the history, so
   * it always equals what a fresh fold of this pane would show.
   */
  private committedRows: HermesEntryPayload[] = []
  private unregisterHistory: (() => void) | null = null
  private signedOut = false
  /** A notice to show once the next history snapshot has caught up. */
  private pendingNotice: string | null = null
  /** A reconnect attempt is running; see reconnect() for why only one may. */
  private reconnecting = false
  /**
   * The conversation is bound on the CURRENT socket. hermes-headless reports
   * a connection `ready` once the socket handshakes, which is BEFORE start()
   * or a reconnect re-attaches the conversation; a prompt sent in that gap
   * named the old runtime id, which a restarted backend refuses, and the
   * refusal is final (round-2 review c2 #4). Input opens only when attached.
   */
  private attached = false
  private readonly onServiceDisconnect = (id: string, reason: HermesDisconnectReason = 'signed-out'): void => {
    if (id !== this.connectionId) return
    this.detach(reason)
  }
  /** Why this pane let go, so only a sign-out (never a removal) is undone by a new sign-in. */
  private detachedFor: HermesDisconnectReason | null = null
  private readonly onServiceSignedIn = (id: string): void => {
    if (id !== this.connectionId || this.stopped || !this.signedOut || this.detachedFor !== 'signed-out') return
    // A fresh sign-in on this connection: re-attach the same conversation.
    // Before this a detached pane stayed dead until Reload Agent (owner's
    // debug bundle 2026-10-14T16-26-49: pane d9567053, 10m42s).
    this.signedOut = false
    this.detachedFor = null
    this.attempt = 0
    this.emit('process-state', { active: false, status: 'Reconnecting to Hermes…' })
    void this.reconnect()
  }

  /**
   * Let go of the server for good (until Reload Agent): signed out, or the
   * connection was removed. Detach, never close: the conversation stays on
   * the server and a later Reload Agent resumes it.
   */
  private detach(reason: HermesDisconnectReason): void {
    if (this.stopped || this.signedOut || !this.headless) return
    // Stays detached: the socket closing below must not start the reconnect
    // loop, which would only redial a connection with no credentials.
    this.signedOut = true
    this.detachedFor = reason
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    // detach(), not stop(): a fresh sign-in re-attaches (onServiceSignedIn).
    void this.headless.detach().catch(() => undefined)
    // Open cards can no longer be answered (the socket is gone), and leaving
    // them up kept the pane "blocked on you" with every click failing
    // (round-1 review c1 #2). Hermes fails them closed on its own timeout.
    if (this.openRequests.length > 0) {
      this.openRequests.length = 0
      this.emitConditions()
    }
    this.emit('input-readiness', { ready: false, reason: 'provider-not-ready' })
    this.emit('process-state', { active: false, status: reason === 'removed' ? 'Hermes connection removed' : 'Signed out of Hermes' })
    this.emitNotice(reason === 'removed'
      ? 'This Hermes connection was removed in Settings. The conversation is still on the server; add the connection again to reach it.'
      : HERMES_SIGNED_OUT_MESSAGE)
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
    this.laneKey = options.hermesLaneKey ?? null
  }

  async start(): Promise<{ projectDir?: string } | void> {
    this.emit('input-readiness', { ready: false, reason: this.storedSessionId ? 'replaying-history' : 'starting' })
    const service = getHermesConnectionService()
    const headless = new HermesHeadless({
      dial: service.dialFor(this.connectionId),
      // Outlives this session: a Reload Agent keeps every tool output it had.
      toolResults: toolResultCacheFor(this.connectionId),
      ...(this.laneKey ? { rest: service.restFor(this.connectionId) } : {}),
      target: this.laneKey
        // Follow the Telegram thread: the stored id is re-resolved from the
        // routing key on open, on every change signal and before every send
        // (hermes-headless lane/lanes.ts), so a Telegram /new never leaves
        // this pane writing into a dead conversation.
        ? { mode: 'lane', sessionKey: this.laneKey }
        : this.storedSessionId
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
      // Held until the new conversation's history has caught up: the reset
      // that follows `session-replaced` wipes every row before it, so a notice
      // emitted now never reached the screen (round-2 review x1 #2).
      this.pendingNotice = `The previous Hermes conversation (${previousStoredSessionId}) is gone from the server, so this pane started a new one.`
    })
    headless.on('notice', (notice: HermesNotice) => this.onHermesNotice(notice))
    headless.on('side-answer', (answer: HermesSideAnswer) => this.onSideAnswer(answer))
    headless.on('turn-lost', () => {
      // The backend restarted mid-turn (new epoch): the reply in progress is
      // gone from the server, and the resume silently resets the bubble.
      // Without this line the answer just vanished (r4 F7, #1495).
      this.pendingNotice = 'Hermes restarted while it was replying, so that reply was lost. Send your message again if you still need it.'
    })
    headless.on('request', (request: HermesRequest) => this.onRequest(request))
    headless.on('lane', (state: HermesLaneState) => this.onLane(state))
    headless.on('lane-moved', (move: LaneMove) => {
      // Telegram /new (or /resume) replaced the thread's conversation. The
      // package resets the history as a new conversation; the line says why
      // the chat just changed under the user. Compression is seamless.
      if (move.reason === 'new-conversation') this.pendingNotice = 'Telegram started a new conversation; this pane follows it.'
    })
    headless.on('hold-failed', ({ text }: { text: string }) => {
      this.emitNotice(`Could not send your held message: ${text.length > 80 ? `${text.slice(0, 79)}…` : text}`)
    })
    headless.on('lane-error', (error: Error) => console.warn('[hermes] lane refresh failed:', describeError(error)))
    headless.on('request-closed', ({ id }: { id: string }) => this.onRequestClosed(id))
    headless.on('connection', (state: HermesConnectionState) => this.onConnection(state))
    service.on('disconnect', this.onServiceDisconnect)
    service.on('signed-in', this.onServiceSignedIn)

    try {
      await headless.start()
    } catch (error) {
      service.off('disconnect', this.onServiceDisconnect)
      service.off('signed-in', this.onServiceSignedIn)
      service.reportReachability(this.connectionId, false, error)
      this.exited = true
      // A failed start is a failed spawn: SessionManager rejects session:spawn
      // and both sides of IPC launder the text, so only the curated sentences
      // survive. classifyHermesStartFailure picks the one that names the
      // real cause (#1495) and carries the stage + codes for the journal;
      // the raw error stays in main's log only.
      console.warn('[hermes] start failed:', describeError(error))
      throw classifyHermesStartFailure(error)
    }
    service.reportReachability(this.connectionId, true)
    this.openInput()
    if (this.laneKey && !this.laneNoticeShown) {
      this.laneNoticeShown = true
      // Plan D6 (owner decision 2026-10-14: no phone delivery). Said once per
      // pane lifetime. Emitted now, not held for the next history boundary:
      // start() has already applied the snapshot, so it lands as the newest
      // line, and a quiet thread may not produce another boundary for hours.
      this.emitNotice('This pane follows your Telegram thread with Hermes. Messages you send here are part of that conversation, but they do not appear in the Telegram app (a Hermes limitation, NousResearch/hermes-agent#76767).')
    }
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
    getHermesConnectionService().off('signed-in', this.onServiceSignedIn)
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
  private openInput(): void {
    if (this.stopped || this.signedOut) return
    this.attached = true
    this.emit('input-readiness', { ready: true, reason: 'ready' })
  }

  async deliverPromptText(text: string): Promise<void> {
    if (!this.headless) throw new HermesPromptError('not-ready', 'The Hermes conversation has not started.')
    // `not-ready` is retry-safe: the composer keeps the message for after
    // the re-attach instead of losing it to a dead runtime id.
    if (!this.attached) throw new HermesPromptError('not-ready', 'Hermes is reconnecting; send again in a moment.')
    if (this.laneKey && /^\/(new|reset|clear)(\s|$)/i.test(text.trim())) {
      // Plan Decision 5 (UNCONFIRMED): Agent Code cannot reset the GATEWAY's
      // routing for the thread, and a pane-side /new would quietly leave it.
      this.emitNotice('To start a new Telegram conversation, type /new in Telegram; this pane will follow it. For a separate desktop-only chat, use “New Separate Hermes Chat”.')
      return
    }
    if (/^\/[a-z0-9]/i.test(text.trim())) {
      const typed = text.trim()
      const command = findComposerCommand(this.composerCommands ?? HERMES_APP_COMMANDS_WITH_REFUSALS, typed.slice(1).split(/\s+/)[0] ?? '')
      if (command?.availability.kind === 'unavailable') {
        // Never sent: these need a surface Agent Code does not have (or are
        // terminal-only in Hermes), and slash.exec would act on the slash
        // worker's copy of the session or print nothing useful.
        this.emitNotice(command.availability.reason)
        return
      }
      if (command?.source === 'app' && command.name === 'restart') {
        void this.restartGateway()
        return
      }
      const outcome = await this.headless.runSlash(typed)
      if (outcome.kind === 'output' && outcome.text.trim()) this.emitNotice(outcome.text.trim())
      if (outcome.kind === 'prefill') this.emitNotice(`Suggested message: ${outcome.text}`)
      if (outcome.kind === 'side-task') {
        this.emitNotice(outcome.side === 'btw'
          ? 'Asked on the side; the answer appears here without interrupting the conversation.'
          : 'Started in the background; the result appears here when it is done.')
      }
      return
    }
    const outcome = await this.headless.prompt(text)
    if (outcome.status === 'held') {
      this.emit('process-state', { active: true, status: 'Hermes is replying on Telegram; your message sends when it finishes.' })
      return
    }
    if (outcome.status === 'queued') {
      // Hermes is still on the previous task and will answer this after it.
      // Without saying so the typing row under the new message read as if
      // Hermes were answering IT (owner's debug bundle: "what is going on?"
      // sent while a gateway restart was still running).
      this.emit('process-state', { active: true, status: 'Your message is queued; Hermes answers it after the current task.' })
    }
  }

  /** The composer picker's catalog (#1497). Cached per attach; the app commands always come along. */
  async listComposerCommands(): Promise<ComposerCommand[]> {
    if (this.composerCommands) return this.composerCommands
    if (!this.headless || !this.attached) return HERMES_APP_COMMANDS_WITH_REFUSALS
    try {
      this.composerCommands = composerCommandsFromCatalog(await this.headless.commandCatalog())
    } catch {
      // An older server or a failed discovery: the picker still offers what
      // Agent Code handles itself, and typed commands still run.
      return HERMES_APP_COMMANDS_WITH_REFUSALS
    }
    return this.composerCommands
  }

  /**
   * `/restart` (#1497): Hermes' gateway restart, through the dashboard
   * (`/restart` is gateway-only and cannot run over the WebSocket). The pane
   * talks to the dashboard process, which this does not restart, so the
   * conversation stays attached while Telegram comes back.
   */
  private async restartGateway(): Promise<void> {
    const service = getHermesConnectionService()
    try {
      await service.restFor(this.connectionId).restartGateway()
    } catch (error) {
      this.emitNotice(`Could not restart Hermes’ gateway: ${describeError(error)}`)
      return
    }
    this.emitNotice('Restarting Hermes’ messaging gateway. Telegram is offline for about a minute.')
    // Watch the unauthenticated status until the gateway reports running
    // again. The first seconds are skipped: right after the request the OLD
    // gateway may still say "running" before it stops.
    const started = Date.now()
    await new Promise((resolve) => setTimeout(resolve, RESTART_SETTLE_MS))
    while (!this.stopped && Date.now() - started < RESTART_DEADLINE_MS) {
      if ((await service.gatewayRunning(this.connectionId)) === true) {
        this.emitNotice('Hermes’ gateway is back.')
        return
      }
      await new Promise((resolve) => setTimeout(resolve, RESTART_POLL_MS))
    }
    if (!this.stopped) this.emitNotice('Hermes’ gateway did not report back within 90 seconds. Check the server (Hostinger → Docker Manager).')
  }

  async resolveCondition(action: ConditionCustomAction): Promise<
    | { ok: true; state?: unknown }
    | { ok: false; reason: string; lastState?: unknown; failedAtStep?: string }
  > {
    if (!this.headless) return { ok: false, reason: 'no-headless' }
    const payload = asRecord(action.payload)
    if (action.name === HERMES_HELD_SEND || action.name === HERMES_HELD_CANCEL) {
      const holdId = typeof payload?.holdId === 'string' ? payload.holdId : null
      if (!holdId || !this.held.some((hold) => hold.id === holdId)) return { ok: false, reason: 'invalid-payload' }
      try {
        if (action.name === HERMES_HELD_SEND) {
          await this.headless.releaseHeld(holdId)
        } else {
          const text = this.headless.cancelHeld(holdId)
          // Main cannot put text back into the composer; the line keeps it
          // so the user can copy it.
          if (text) this.emitNotice(`Not sent: ${text}`)
        }
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: 'aborted', failedAtStep: `held prompt: ${describeError(error)}` }
      }
    }
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
      ...(boundary.type === 'reset' && boundary.reason === 'new-conversation' ? { conversationChanged: true } : {}),
      file: hermesTranscriptSource(this.connectionId, this.storedSessionId ?? ''),
    })
    if (boundary.type === 'caught-up' && this.pendingNotice) {
      const text = this.pendingNotice
      this.pendingNotice = null
      this.emitNotice(text)
    }
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
      // Socket up, conversation not yet attached: start() and reconnect()
      // open input themselves once they finish.
      this.connectedAt = Date.now()
      return
    }
    if (state.kind === 'disconnected') {
      this.attached = false
      // A reconnect may land on an upgraded or restarted server; refetch.
      this.composerCommands = null
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

  /**
   * One attempt at a time. A failed attach leaves its socket open, and the
   * NEXT attempt's connect() closes it, which fires `disconnected` again; when
   * that also scheduled a retry, two chains ran at once and kept cancelling
   * each other's dials (round-1 review c1 #1: 266 dials, 2 open at once).
   * So a retry that fires while an attempt runs is dropped (the early return
   * below), and a failed attempt schedules exactly one retry after it ends.
   */
  private async reconnect(): Promise<void> {
    if (this.stopped || this.signedOut || !this.headless || this.reconnecting) return
    const service = getHermesConnectionService()
    this.reconnecting = true
    let retry = false
    try {
      await this.headless.reconnect()
      service.reportReachability(this.connectionId, true)
      this.openInput()
    } catch (error) {
      // Not transient: retrying a dead sign-in or a removed connection would
      // spin forever. The pane says what to do instead.
      if (error instanceof HermesSignedOutError) this.detach('signed-out')
      else if (error instanceof HermesConnectionMissingError) this.detach('removed')
      else {
        service.reportReachability(this.connectionId, false, error)
        retry = true
      }
    } finally {
      this.reconnecting = false
    }
    if (retry) this.scheduleReconnect()
  }

  /**
   * Hermes' out-of-band notices (#1497 Stage B). `ttl` ones are transient by
   * Hermes' own definition ("still starting the agent…") and go to the
   * activity line; everything else (provider warnings, model-switch
   * refusals, memory updates, risky tool output) becomes a readable line in
   * the chat, because before this they were dropped and the pane looked
   * fine while Hermes was telling the user something was wrong.
   */
  private onHermesNotice(notice: HermesNotice): void {
    if (this.stopped || this.signedOut) return
    if (notice.kind === 'ttl') {
      this.emit('process-state', { active: true, status: notice.text })
      return
    }
    const prefix = notice.level === 'error' ? 'Hermes error: ' : notice.level === 'warn' ? 'Hermes: ' : ''
    this.emitNotice(`${prefix}${notice.text}`)
  }

  /** `/bg` and `/btw` answers: beside the conversation, never an assistant turn. */
  private onSideAnswer(answer: HermesSideAnswer): void {
    if (this.stopped || this.signedOut) return
    const label = answer.kind === 'btw' ? `By the way${answer.question ? ` (${answer.question})` : ''}` : 'Background task finished'
    this.emitNotice(`${label}:\n${answer.text}`)
  }

  private onRequest(request: HermesRequest): void {
    // A detached pane (stopped, signed out, connection removed) shows no new
    // card: nothing can answer it on a socket that is gone (round-2 review
    // c1 #4, where a request surfaced late by a failed attach reopened one).
    if (this.stopped || this.signedOut) return
    // Backstop only: hermes-headless already drops a repeated request id
    // (ConversationReconciler.openRequest, its own tests), so no app test can
    // reach this line today. It stays because a duplicate here would show as
    // "+1 more waiting" for a request that does not exist.
    if (this.openRequests.some((entry) => entry.id === request.id)) return
    this.openRequests.push(request)
    this.requestReceivedAt.set(request.id, Date.now())
    this.emitConditions()
  }

  private onRequestClosed(id: string): void {
    const index = this.openRequests.findIndex((entry) => entry.id === id)
    if (index < 0) return
    this.openRequests.splice(index, 1)
    this.emitConditions()
  }

  private onLane(state: HermesLaneState): void {
    if (this.stopped || this.signedOut) return
    const heldChanged = state.held.length !== this.held.length || state.held.some((hold, index) => hold.id !== this.held[index]?.id)
    this.held = state.held.map(({ id, text }) => ({ id, text }))
    if (heldChanged) this.emitConditions()
    this.emit('process-state', state.busy
      ? { active: true, status: 'Hermes is replying on Telegram…' }
      : { active: false, status: undefined })
  }

  private emitConditions(): void {
    const conditions: Record<string, ProviderConditionRecord> = {}
    if (this.held.length > 0) {
      conditions['hermes.held'] = {
        kind: 'hermes.held',
        state: { visible: true, held: this.held.map((hold) => ({ ...hold })) },
        actions: this.held.flatMap((hold): ConditionCustomAction[] => [
          { kind: 'custom', id: `${hold.id}:send`, label: 'Send now', name: HERMES_HELD_SEND, payload: { holdId: hold.id } },
          { kind: 'custom', id: `${hold.id}:cancel`, label: 'Cancel', name: HERMES_HELD_CANCEL, payload: { holdId: hold.id } },
        ]),
      } as ProviderConditionRecord
    }
    for (const method of Object.keys(KIND_BY_METHOD) as Array<HermesRequest['method']>) {
      const pending = this.openRequests.filter((request) => request.method === method)
      if (pending.length === 0) continue
      conditions[KIND_BY_METHOD[method]] = conditionRecord(pending[0], pending.length - 1, this.requestReceivedAt.get(pending[0].id))
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
/** Hermes' own fixed waits for typed answers (r3 A5): the card counts down to them. */
const VALUE_REQUEST_WAIT_MS: Record<'sudo' | 'secret', number> = { sudo: 120_000, secret: 300_000 }

export function conditionRecord(request: HermesRequest, queued: number, receivedAt?: number): ProviderConditionRecord {
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
          // A replayed request (after a reconnect) arrived at an unknown
          // point of its wait: no countdown rather than a wrong one.
          expiresAt: !request.replayed && receivedAt !== undefined ? receivedAt + VALUE_REQUEST_WAIT_MS[request.method] : null,
        },
        actions: [declineAction(request.id, 'Skip')],
      }
    }
  }
}
