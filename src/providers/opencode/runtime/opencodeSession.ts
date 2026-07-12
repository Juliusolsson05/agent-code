// OpencodeSession — the AgentSession runtime for opencode (#406 step 3).
//
// Unlike ClaudeSession/CodexSession this wrapper owns NO PTY. Opencode
// exposes a local HTTP+SSE server (`opencode serve`); OpencodeHeadless
// spawns that server, subscribes to its event bus, and republishes the
// same three-channel truth model (semantic / screen / committed) the
// other providers already speak. This class is therefore a pure event
// TRANSLATION layer: OpencodeHeadless's channel/bus events → the typed
// AgentSessionEvents surface sessionManager subscribes to. There is no
// terminal to spawn, resize, or write keystrokes into — those methods
// are permanent no-ops (see write/resize) and input flows exclusively
// through deliverPrompt (HTTP, step 5) and condition custom actions
// (HTTP permission replies, step 6).
//
// WHY translate here instead of teaching sessionManager opencode's
// vocabulary: the whole point of the headless packages + AgentSession
// contract is that main stays provider-agnostic. sessionManager already
// forwards `started`/`exit`/`process-state`/`jsonl-entry`/`jsonl-error`/
// `semantic-event`/`conditions` verbatim; a third provider earns its
// pane by emitting those same events, nothing more.

import { EventEmitter } from 'events'

import { OpencodeHeadless } from 'opencode-headless'
import type {
  CommittedEntryEvent,
  ScreenActivityEvent,
  ScreenPermissionEvent,
  ScreenQuestionEvent,
  SemanticEvent,
} from 'opencode-headless'
import type {
  AgentSession,
  AgentSessionEvents,
  AgentTranscriptEntry,
  SessionOptions,
} from '@shared/types/session.js'
import type {
  ConditionAction,
  ConditionCustomAction,
  OpencodePermissionState,
  OpencodeQuestionState,
  ProviderConditionRecord,
  ProviderConditionSnapshot,
} from '@shared/types/providerConditions.js'
import { asRecord } from '@shared/lib/asRecord.js'

// Custom-action names OpencodeSession both BUILDS (when folding a
// permission/question into the snapshot) and DISPATCHES (in
// resolveCondition). Kept as constants so the two halves can never drift
// — a rename that touches only one side is a compile error at the other.
const PERMISSION_REPLY = 'opencode.permission.reply'
const QUESTION_REJECT = 'opencode.question.reject'

// The three replies OpenCode's permission API accepts. Declared here so
// resolveCondition can validate an inbound payload against it rather than
// trusting the renderer to send a legal string.
const PERMISSION_REPLIES = ['once', 'always', 'reject'] as const
type PermissionReplyValue = (typeof PERMISSION_REPLIES)[number]

// Synthetic "source" string for jsonl-entry's second argument. The
// PTY providers pass a real transcript file path here (Claude's
// <id>.jsonl, Codex's rollout path); opencode has no durable file at
// this seam (#406 blocker 2 — history arrives via the committed replay,
// not a file loader), so we mint a stable URI instead. Consumers that
// only display or key off this string stay happy; the mapper (step 4)
// keys off the entry body, not this argument.
function transcriptSource(sessionID: string): string {
  return `opencode://session/${sessionID}`
}

function isPermissionReply(value: unknown): value is PermissionReplyValue {
  return typeof value === 'string' && (PERMISSION_REPLIES as readonly string[]).includes(value)
}

// Interface merge: give the class typed on/off/once/emit against the
// AgentSessionEvents map (same pattern CodexSession/ClaudeSession use).
// Without this, `this.emit('process-state', …)` inside the class
// resolves to EventEmitter's untyped signature and a wrong payload
// shape would compile. The `implements AgentSession` clause alone does
// NOT retype the inherited methods as seen from inside the class body.
export interface OpencodeSession {
  on<K extends keyof AgentSessionEvents>(
    event: K,
    listener: (...args: AgentSessionEvents[K]) => void,
  ): this
  off<K extends keyof AgentSessionEvents>(
    event: K,
    listener: (...args: AgentSessionEvents[K]) => void,
  ): this
  once<K extends keyof AgentSessionEvents>(
    event: K,
    listener: (...args: AgentSessionEvents[K]) => void,
  ): this
  emit<K extends keyof AgentSessionEvents>(
    event: K,
    ...args: AgentSessionEvents[K]
  ): boolean
}

export class OpencodeSession extends EventEmitter implements AgentSession {
  private headless: OpencodeHeadless | null = null
  private exited = false

  // Live conditions keyed by kind (at most one per kind at a time), the
  // erased-record form the wire snapshot carries. OpencodeSession OWNS
  // this map: it folds the headless screen permission/question events in
  // here and re-emits a full snapshot on every change. Unlike Codex —
  // which forwards a snapshot the headless already assembled — opencode's
  // headless exposes only raw permission/question events, so building the
  // ProviderConditionSnapshot (kinds, actions, clearing on resolve) is
  // this wrapper's job.
  private readonly liveConditions = new Map<string, ProviderConditionRecord>()

  private readonly cwd: string
  private readonly binary: string | undefined
  private readonly env: Record<string, string | undefined> | undefined
  private readonly resumeSessionId: string | null

  constructor(options: SessionOptions) {
    super()
    this.cwd = options.cwd
    // Leave undefined → OpencodeHeadless/SpawnedServer default to the
    // 'opencode' binary on PATH. Passing an empty string would spawn ''.
    this.binary = options.binary
    // SpawnedServer already merges process.env under opts.env, so we
    // forward only the caller's overrides (unlike CodexSession, which
    // must rebuild the whole env for node-pty). No TERM/COLORTERM here:
    // there is no terminal to color.
    this.env = options.env
    this.resumeSessionId = options.resumeSessionId ?? null
  }

  async start(): Promise<{ projectDir?: string } | void> {
    const headless = new OpencodeHeadless({
      mode: 'spawn',
      cwd: this.cwd,
      binary: this.binary,
      env: this.env,
      // Resume replays that session's committed history inside start()
      // (publishSessionMessages), which is why every listener below is
      // attached BEFORE start() is awaited — otherwise the replayed
      // `entry` events fire into the void and the pane opens blank.
      sessionID: this.resumeSessionId ?? undefined,
    })
    this.headless = headless

    headless.on('exit', ({ exitCode }) => {
      this.exited = true
      // AgentSession's exit payload types exitCode as a number; the
      // server can exit with a null code when killed by a signal.
      // Normalize null → -1, matching how the PTY providers report a
      // signal-kill (they surface a non-zero code, never null).
      this.emit('exit', { exitCode: exitCode ?? -1 })
    })

    // activity → process-state. Opencode derives active/status from its
    // SSE bus (session.idle, message streaming), so the renderer's
    // ActivityIndicator gets a real status verb instead of falling back
    // to Claude's screen-scraping detector (which returns null with no
    // screen to scrape).
    headless.screen.on('activity', (ev: ScreenActivityEvent) => {
      this.emit('process-state', { active: ev.active, status: ev.status ?? undefined })
    })

    // committed entry → jsonl-entry. These are durable messages (the
    // initial resume replay AND live turn commits). The renderer's
    // opencode transcript mapper (providers/opencode/renderer/transcript/
    // mapper.ts) fans each one into Claude-shaped feed entries —
    // assistant/user rows plus per-tool-part tool_result rows.
    //
    // CONTRACT the mapper depends on: a committed entry must carry the
    // full `{ info, parts }` message shape (what GET /session/:id/message
    // returns). The resume replay (publishSessionMessages) satisfies it;
    // the LIVE path is the trap — the SSE `message.updated` event carries
    // only the bare info WITHOUT parts until the headless assembles a
    // complete commit (fetch-on-complete; see the companion
    // packages/opencode-headless fix). The mapper defends by dropping
    // assistant messages that lack info.time.completed, so a parts-less
    // mid-stream republish can't double-render what the semantic
    // streaming card below is already painting live.
    headless.committed.on('entry', (entry: CommittedEntryEvent) => {
      this.emit('jsonl-entry', this.toTranscriptEntry(entry), transcriptSource(entry.sessionID))
    })

    // History fetch failures (resume replay, refreshHistory) surface as
    // a soft feed error rather than killing the pane — same treatment
    // the PTY providers give a transcript-tailer read error.
    headless.committed.on('history_error', (err: Error) => {
      this.emit('jsonl-error', err)
    })

    // semantic → semantic-event, forwarded verbatim. The renderer
    // narrows by ev.type; main must not couple to opencode's vocabulary.
    headless.semantic.on('event', (ev: SemanticEvent) => {
      this.emit('semantic-event', ev)
    })

    // Transport-level SSE failures also degrade to a soft feed error.
    // The SseClient auto-reconnects (retryMs) by default, so this is a
    // notice, not a terminal condition.
    headless.on('sse-error', (err: Error) => {
      this.emit('jsonl-error', err)
    })

    // Permission / question screen events → `conditions` snapshot. The
    // headless publishes visible:true when opencode asks and (on some
    // paths) visible:false when it clears; we also clear on resolve
    // (resolveCondition) so the modal disappears the instant the user
    // acts, independent of whether opencode emits a clear event.
    headless.screen.on('permission', (ev: ScreenPermissionEvent) => {
      this.foldPermission(ev.state)
    })
    headless.screen.on('question', (ev: ScreenQuestionEvent) => {
      this.foldQuestion(ev.state)
    })

    try {
      await headless.start()
    } catch (err) {
      // A half-started headless may hold a bound port and a live child.
      // Roll it back so the caller can retry cleanly instead of leaking
      // a server nobody will ever stop() (mirrors CodexSession's
      // rollbackStart discipline).
      try {
        await headless.stop()
      } catch {
        /* best-effort */
      }
      this.headless = null
      throw err
    }

    // Opencode has no per-cwd transcript directory to report as
    // projectDir (its storage root is server-owned, #406 blocker 1), so
    // `started` carries no projectDir. Consumers already type it
    // optional (see AgentSessionEvents.started).
    this.emit('started', {})
    return {}
  }

  /** Build the jsonl-entry payload from a committed message.
   *
   *  extractOpencodeProviderSessionId (Pass A of history ingest) reads
   *  `raw.info.sessionID` first and falls back to `raw.sessionID`.
   *  Opencode messages carry `info.sessionID` today, but we defensively
   *  stamp the envelope's sessionID at the top level too so the extractor
   *  never fails — WITHOUT overwriting a sessionID the body already
   *  carries (the body is the source of truth when present). */
  private toTranscriptEntry(entry: CommittedEntryEvent): AgentTranscriptEntry {
    const message = entry.message
    const base: Record<string, unknown> =
      message && typeof message === 'object' && !Array.isArray(message)
        ? (message as Record<string, unknown>)
        : { message }
    if (typeof base.sessionID === 'string' && base.sessionID.length > 0) return base
    return { ...base, sessionID: entry.sessionID }
  }

  // ── Conditions (permission / question) ────────────────────────────

  private foldPermission(state: ScreenPermissionEvent['state']): void {
    // No requestID = nothing we could reply to; treat as a clear.
    if (!state.visible || !state.requestID) {
      if (this.liveConditions.delete('opencode.permission')) this.emitConditionsSnapshot()
      return
    }
    const requestID = state.requestID
    const permissionState: OpencodePermissionState = {
      visible: true,
      requestID,
      title: state.title,
      metadata: state.metadata,
    }
    const actions: ConditionAction[] = [
      this.permissionAction(requestID, 'once', 'Allow once'),
      this.permissionAction(requestID, 'always', 'Allow always'),
      this.permissionAction(requestID, 'reject', 'Reject'),
    ]
    this.liveConditions.set('opencode.permission', {
      kind: 'opencode.permission',
      state: permissionState,
      actions,
    })
    this.emitConditionsSnapshot()
  }

  private permissionAction(
    requestID: string,
    reply: PermissionReplyValue,
    label: string,
  ): ConditionCustomAction {
    return {
      kind: 'custom',
      id: `${requestID}:${reply}`,
      label,
      name: PERMISSION_REPLY,
      payload: { requestID, reply },
    }
  }

  private foldQuestion(state: ScreenQuestionEvent['state']): void {
    if (!state.visible || !state.questionID) {
      if (this.liveConditions.delete('opencode.question')) this.emitConditionsSnapshot()
      return
    }
    const questionID = state.questionID
    const questionState: OpencodeQuestionState = {
      visible: true,
      questionID,
      text: state.text,
      metadata: state.metadata,
    }
    // v1 is reject-only. opencode's question payload carries no parsed
    // option list at this seam, so offering a real Reject that unblocks
    // the turn beats guessing answer strings; structured answering
    // (replyQuestion) is a follow-up that only touches this method and
    // the QUESTION_* action names — the view already renders whatever
    // actions arrive.
    const actions: ConditionAction[] = [
      {
        kind: 'custom',
        id: `${questionID}:reject`,
        label: 'Reject',
        name: QUESTION_REJECT,
        payload: { questionID },
      },
    ]
    this.liveConditions.set('opencode.question', {
      kind: 'opencode.question',
      state: questionState,
      actions,
    })
    this.emitConditionsSnapshot()
  }

  private emitConditionsSnapshot(): void {
    const conditions: Record<string, ProviderConditionRecord> = {}
    for (const [kind, record] of this.liveConditions) conditions[kind] = record
    const snapshot: ProviderConditionSnapshot = {
      provider: 'opencode',
      conditions,
      ts: Date.now(),
    }
    this.emit('conditions', snapshot)
  }

  /** Resolve an opencode condition custom action over HTTP. This is the
   *  AgentSession.resolveCondition capability — opencode routes ALL
   *  condition actions here (no PTY keystroke arm) via
   *  session:resolveCondition. Clears the resolved condition immediately
   *  so the modal closes on the user's action rather than waiting for a
   *  clear event that opencode may or may not send. */
  async resolveCondition(
    action: ConditionCustomAction,
  ): Promise<
    | { ok: true; state?: unknown }
    | { ok: false; reason: string; lastState?: unknown; failedAtStep?: string }
  > {
    if (!this.headless) return { ok: false, reason: 'no-headless' }
    const payload = asRecord(action.payload)

    if (action.name === PERMISSION_REPLY) {
      const requestID = payload && typeof payload.requestID === 'string' ? payload.requestID : null
      const reply = payload?.reply
      if (!requestID || !isPermissionReply(reply)) {
        return { ok: false, reason: 'invalid-payload' }
      }
      try {
        await this.headless.permissionService.reply(requestID, reply)
      } catch (err) {
        return {
          ok: false,
          reason: 'aborted',
          failedAtStep: `permission.reply: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
      if (this.liveConditions.delete('opencode.permission')) this.emitConditionsSnapshot()
      return { ok: true }
    }

    if (action.name === QUESTION_REJECT) {
      const questionID = payload && typeof payload.questionID === 'string' ? payload.questionID : null
      if (!questionID) return { ok: false, reason: 'invalid-payload' }
      try {
        await this.headless.rejectQuestion(questionID)
      } catch (err) {
        return {
          ok: false,
          reason: 'aborted',
          failedAtStep: `question.reject: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
      if (this.liveConditions.delete('opencode.question')) this.emitConditionsSnapshot()
      return { ok: true }
    }

    // Unknown action name — a renderer sent a resolver opencode doesn't
    // own. Fail structured (never silent success), matching the contract.
    return { ok: false, reason: 'no-resolver' }
  }

  /** Deliver a text prompt over HTTP. This is the AgentSession
   *  `deliverPromptText` capability (the opposite of the PTY providers'
   *  io.write path) — the opencode deliverPrompt protocol calls it so
   *  the registry never learns opencode's transport. Throws if the
   *  session hasn't started (no server URL / SyncClient yet) so the
   *  protocol reports ok:false and the composer keeps the draft. */
  async deliverPromptText(text: string): Promise<void> {
    if (!this.headless) {
      throw new Error('opencode session has not started — cannot deliver prompt')
    }
    // prompt() defaults sessionID to the active/ensured session, so a
    // fresh pane that never resumed still gets a session created on the
    // first prompt.
    await this.headless.prompt({ prompt: text })
  }

  async stop(): Promise<void> {
    try {
      await this.headless?.stop()
    } catch (err) {
      console.warn('[opencodeSession] headless.stop() failed:', err)
    }
    this.headless = null
  }

  /** Opencode has NO PTY — there are no raw bytes to write. Permanent
   *  no-op by design; input flows through sendPrompt (HTTP) and
   *  condition custom actions (#406 §B). */
  write(_data: string): void {}

  /** No PTY → no terminal geometry. Permanent no-op by design. */
  resize(_cols: number, _rows: number): void {}

  isExited(): boolean {
    return this.exited
  }

  getProcessPid(): number | null {
    // The spawned `opencode serve` child is the process whose CPU/RSS
    // belongs to this pane (spawn mode). Null before start / after exit
    // / in attach mode.
    return this.headless?.processPid ?? null
  }
}
