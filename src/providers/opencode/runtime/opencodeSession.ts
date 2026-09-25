import { excludeExternalControlFromOpencode } from '@providers/shared/runtime/externalControlExclusion.js'
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
import {
  OPENCODE_QUESTION_REJECT,
  OPENCODE_QUESTION_REPLY,
  parseOpencodeQuestions,
  validateQuestionAnswers,
} from './questionAnswers.js'
import { opencodeTranscriptFile } from 'opencode-terminal-headless'
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
import { addOpencodeBuiltInMcpLaunchConfig } from '@providers/shared/runtime/builtInMcpLaunch.js'
import { mapOpenCodeSemanticEvent, OpenCodeBlockIndexTracker } from './semanticMapping.js'

// Custom-action names OpencodeSession both BUILDS (when folding a
// permission/question into the snapshot) and DISPATCHES (in
// resolveCondition). Kept as constants so the two halves can never drift
// — a rename that touches only one side is a compile error at the other.
//
// The two QUESTION names are imported rather than declared because since
// #1025 a THIRD party knows them: the view composes a multi-question reply
// and filters the runtime's per-option actions out of the footer by name. A
// constant private to this file could not bind that half, so the names moved
// to `questionAnswers.ts` — the one question module both processes import.
const PERMISSION_REPLY = 'opencode.permission.reply'
const QUESTION_REJECT = OPENCODE_QUESTION_REJECT
const QUESTION_REPLY = OPENCODE_QUESTION_REPLY

// The three replies OpenCode's permission API accepts. Declared here so
// resolveCondition can validate an inbound payload against it rather than
// trusting the renderer to send a legal string.
const PERMISSION_REPLIES = ['once', 'always', 'reject'] as const
type PermissionReplyValue = (typeof PERMISSION_REPLIES)[number]

// jsonl-entry's second argument. The PTY providers pass a real transcript
// file path here (Claude's <id>.jsonl, Codex's rollout path); OpenCode has
// no file per session, so both OpenCode runtimes publish the
// `opencode://session/<id>` locator, whose format opencode-terminal-headless
// owns. Main's transcript readers (agent transcript MCP tools, Agent
// Management, remote history) route that locator to OpenCode's database.
function transcriptSource(sessionID: string): string {
  return opencodeTranscriptFile(sessionID)
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
  private readonly extraEnv: Record<string, string | undefined>
  private readonly resumeSessionId: string | null
  /** See the assignment in start(). */
  private liveSessionId: string | null = null
  private readonly builtInMcpServers: NonNullable<SessionOptions['builtInMcpServers']>

  constructor(options: SessionOptions) {
    super()
    this.cwd = options.cwd
    // Leave undefined → OpencodeHeadless/SpawnedServer default to the
    // 'opencode' binary on PATH. Passing an empty string would spawn ''.
    this.binary = options.binary
    this.extraEnv = options.env ?? {}
    this.resumeSessionId = options.resumeSessionId ?? null
    this.builtInMcpServers = options.builtInMcpServers ?? []
  }

  async start(): Promise<{ projectDir?: string } | void> {
    this.emit('input-readiness', {
      ready: false,
      reason: this.resumeSessionId ? 'replaying-history' : 'provider-not-ready',
    })
    // OpenCode's inline config is the only launch-scoped way to add MCP
    // servers without modifying user files. Build a clean, one-start env so
    // generated bearer variables are inherited by `opencode serve` but never
    // retained as mutable session state or copied into the config JSON itself.
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') env[key] = value
    }
    for (const [key, value] of Object.entries(this.extraEnv)) {
      if (value === undefined) delete env[key]
      else env[key] = value
    }
    addOpencodeBuiltInMcpLaunchConfig(this.builtInMcpServers, env)
    excludeExternalControlFromOpencode(env)

    const headless = new OpencodeHeadless({
      mode: 'spawn',
      cwd: this.cwd,
      binary: this.binary,
      env,
      // Resume replays that session's committed history inside start()
      // (publishSessionMessages), which is why every listener below is
      // attached BEFORE start() is awaited — otherwise the replayed
      // `entry` events fire into the void and the pane opens blank.
      sessionID: this.resumeSessionId ?? undefined,
    })
    this.headless = headless

    // The live conversation's id. The package keeps its own copy private, and
    // this is the only thing that can name the session row a prompt's model
    // selection is read from (conversationSelection). A resume knows it up
    // front; a fresh pane learns it when the server creates one.
    this.liveSessionId = this.resumeSessionId ?? null
    headless.on('ready', ({ sessionID }: { sessionID: string | null }) => {
      if (sessionID) this.liveSessionId = sessionID
    })
    headless.on('session', (sessionID: string) => {
      this.liveSessionId = sessionID
    })

    headless.on('exit', ({ exitCode }) => {
      this.exited = true
      this.emit('input-readiness', { ready: false, reason: 'provider-not-ready' })
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

    // semantic → semantic-event, translated onto the shared fold's
    // vocabulary (blockIndex + the field names the fold reads). The package
    // keys block events by blockId only; the fold DROPS events without a
    // numeric blockIndex, so without this mapping live tool blocks,
    // thinking, and tool input never fold (see semanticMapping.ts for the
    // full WHY). Main still couples to nothing — the mapper is a pure
    // shape translation inside the opencode boundary.
    const blockIndexes = new OpenCodeBlockIndexTracker()
    headless.semantic.on('event', (ev: SemanticEvent) => {
      this.emit('semantic-event', mapOpenCodeSemanticEvent(ev, blockIndexes) as SemanticEvent)
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

    if (this.exited || this.headless !== headless) {
      // WHY a resolved start promise is not sufficient evidence of liveness:
      // the spawned server can emit exit while history publication is still
      // unwinding, then let start() resolve. Emitting ready/started afterward
      // creates a phantom writable backend in SessionManager. Treat the exit as
      // the authoritative fact and run the same rollback as a rejected start.
      try {
        await headless.stop()
      } catch {
        /* best-effort */
      }
      if (this.headless === headless) this.headless = null
      throw new Error('opencode exited during startup')
    }

    this.emit('input-readiness', { ready: true, reason: 'ready' })

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
    const questions = parseOpencodeQuestions(state.metadata)
    const questionState: OpencodeQuestionState = {
      visible: true,
      questionID,
      text: state.text,
      metadata: state.metadata,
      questions,
    }
    // ── WHY ONE ACTION PER OPTION ONLY FOR A SINGLE QUESTION (#1025) ──
    // `answers` is POSITIONAL — one entry per question, submitted once — so a
    // multi-question prompt cannot be answered by a single click on one
    // option. That case needs a selection per question and a submit, which is
    // view state; the view composes a QUESTION_REPLY payload and
    // `resolveConditionAction` validates it against these same options.
    //
    // The single-question case is the common one and stays a plain action, so
    // the runtime remains the source of truth for what may be chosen and the
    // view stays dumb for it.
    const actions: ConditionAction[] = []
    if (questions.length === 1) {
      for (const option of questions[0]!.options) {
        actions.push({
          kind: 'custom',
          id: `${questionID}:answer:${option.label}`,
          label: option.label,
          name: QUESTION_REPLY,
          payload: { questionID, answers: [[option.label]] },
        })
      }
    }
    actions.push({
      kind: 'custom',
      id: `${questionID}:reject`,
      label: 'Reject',
      name: QUESTION_REJECT,
      payload: { questionID },
    })
    this.liveConditions.set('opencode.question', {
      kind: 'opencode.question',
      state: questionState,
      actions,
    })
    this.emitConditionsSnapshot()
  }

  /**
   * The live question, but ONLY if it is the one this payload is answering.
   *
   * ── WHY THE IDs MUST BE COMPARED (#1068 review, finding 2) ──
   * An action carries the questionID it was BUILT with; `liveConditions`
   * holds whatever question is current at RESOLVE time. Those are not the
   * same thing, because `foldQuestion` overwrites the record in place when
   * OpenCode replaces a question (`question.updated` and `question.asked`
   * both land there), and a click can be in flight across that swap.
   *
   * Without this check the two halves came apart in the worst possible way:
   * the answer was validated against the NEW question's options, sent to the
   * OLD question's id, and then the new question's modal was torn down
   * unanswered — so the user watched a prompt they were looking at vanish
   * while a dead question received a reply they never gave it, and the agent
   * waiting on the live one was left blocked with no UI to unblock it.
   *
   * A question that was fully CLEARED was already safe (no record → no
   * options → the validator refuses). It is specifically replacement that
   * slipped through, and only an id comparison catches it.
   *
   * Returning the record rather than a boolean is deliberate: the caller then
   * physically cannot validate against one question and reply about another.
   */
  private liveQuestion(
    payload: Record<string, unknown> | null,
  ): { questionID: string; state: OpencodeQuestionState } | null {
    const questionID = payload && typeof payload.questionID === 'string' ? payload.questionID : null
    if (!questionID) return null
    const live = this.liveConditions.get('opencode.question')
    if (live?.kind !== 'opencode.question') return null
    const state = live.state as OpencodeQuestionState
    if (state.questionID !== questionID) return null
    return { questionID, state }
  }

  /**
   * Drop the question record, but only while it is still the one that was
   * resolved.
   *
   * The old code deleted unconditionally. Between the `await` on the HTTP
   * reply and this line OpenCode can publish a NEW question, and destroying
   * that one leaves its agent blocked with nothing on screen to answer it.
   * `liveQuestion` above guarantees the id matched when we started; this
   * guarantees it still matches when we finish.
   */
  private clearResolvedQuestion(questionID: string): void {
    const live = this.liveConditions.get('opencode.question')
    if (live?.kind !== 'opencode.question') return
    if ((live.state as OpencodeQuestionState).questionID !== questionID) return
    this.liveConditions.delete('opencode.question')
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

    if (action.name === QUESTION_REPLY) {
      // ── THE TRUST BOUNDARY (#1025) ──
      // The view may COMPOSE a choice — it has to, because a multi-question
      // prompt is answered as one positional set and that is selection state
      // — but it must never INVENT one. `validateQuestionAnswers` checks every
      // submitted label against the options THIS runtime published for that
      // question, so a renderer cannot answer a question OpenCode did not ask
      // or with a label it did not offer. It is a separate pure function so
      // the boundary is testable without standing up a session.
      const live = this.liveQuestion(payload)
      if (!live) return { ok: false, reason: 'invalid-payload' }
      const answers = validateQuestionAnswers(live.state.questions ?? [], payload?.answers)
      if (!answers) return { ok: false, reason: 'invalid-payload' }
      try {
        await this.headless.replyQuestion(live.questionID, answers)
      } catch (err) {
        return {
          ok: false,
          reason: 'aborted',
          failedAtStep: `question.reply: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
      this.clearResolvedQuestion(live.questionID)
      return { ok: true }
    }

    if (action.name === QUESTION_REJECT) {
      const live = this.liveQuestion(payload)
      if (!live) return { ok: false, reason: 'invalid-payload' }
      try {
        await this.headless.rejectQuestion(live.questionID)
      } catch (err) {
        return {
          ok: false,
          reason: 'aborted',
          failedAtStep: `question.reject: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
      this.clearResolvedQuestion(live.questionID)
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
    // The selection and the destination are ONE decision (#1038 re-review):
    // the row read is async, and the live session can change while it is in
    // flight — a reload, a switch, the TUI navigating away. Submitting with
    // the default destination then sent session A's agent, model and variant
    // to session B, which OpenCode persists onto B's row. Pin both together,
    // or send neither.
    const pinned = await this.conversationSelection()
    await this.headless.prompt({ prompt: text, ...pinned })
  }

  /**
   * The agent, model and variant THIS conversation runs on, read from its own
   * session row immediately before a prompt.
   *
   * WHY the prompt has to carry them at all (#1038 review): OpenCode resolves
   * a submission's model as `input.model ?? agent.model ?? session model`, so
   * a machine-level `agent.build.model` outranks the session's own selection.
   * A duplicated or rewound conversation therefore kept its model in every
   * imported message and then answered the next prompt on whatever this
   * machine's config named — which is the exact loss #1038 is about, one
   * layer below the transcript. Reproduced against the 1.18.30 binary with
   * `agent.build.model = opencode/big-pickle`.
   *
   * WHY agent AND model AND variant, never a subset: OpenCode persists what a
   * prompt selects back onto the session row, so a partial selection MOVES
   * the conversation — sending a model without an agent re-homes it to the
   * default agent, permanently.
   *
   * WHY it is re-read per prompt instead of cached at start: the row is the
   * source of truth and it changes underneath us — the TUI, another client or
   * a model switch all write it. One local HTTP GET against a server on this
   * machine is cheaper than a stale selection that silently re-homes the
   * session. A failure or an unparseable row yields no selection at all,
   * which is exactly the behaviour that shipped before this existed.
   */
  private async conversationSelection(): Promise<{
    sessionID?: string
    agent?: string
    providerID?: string
    modelID?: string
    variant?: string
  }> {
    const sessionID = this.liveSessionId
    if (!this.headless || !sessionID) return {}
    const row = await this.headless.client.getSession(sessionID).catch(() => null)
    // The session moved while the row was in flight. Its selection is not this
    // session's to send, and sending it would write A's model onto B's row.
    if (this.liveSessionId !== sessionID) return {}
    if (!isRecord(row)) return {}
    const model = isRecord(row.model) ? row.model : null
    // The session row spells the model `id`, not `modelID` as a message does.
    const text = (value: unknown): string | undefined =>
      typeof value === 'string' && value.length > 0 ? value : undefined
    const modelID = text(model?.id)
    const providerID = text(model?.providerID)
    const variant = text(model?.variant)
    const agent = text(row.agent)
    // ALL FOUR or nothing (#1038 re-review found model+variant going without
    // an agent, and agent+model going without a variant). OpenCode persists
    // what a prompt selects back onto the row, so a partial selection does
    // not merely under-specify this one submission — it REWRITES the
    // conversation's own selection, permanently, to whatever the server fills
    // the gaps with. A row that cannot answer all four is a row we do not
    // act on; the server's own defaults then apply, exactly as they did
    // before any of this existed.
    if (!modelID || !providerID || !variant || !agent) return {}
    return { sessionID, agent, modelID, providerID, variant }
  }

  async stop(): Promise<void> {
    try {
      await this.headless?.stop()
    } catch (err) {
      console.warn('[opencodeSession] headless.stop() failed:', err)
    }
    this.headless = null
  }

  /** This structured OpenCode runtime has NO PTY — there are no raw bytes to
   *  write. Permanent no-op by design; input flows through sendPrompt (HTTP)
   *  and condition custom actions (#406 §B). The separate terminal runtime
   *  implements real write/resize methods. */
  write(data: string): void {
    // The structured runtime has no PTY to write bytes into — EXCEPT that
    // the app's universal interrupt is the Esc byte, and this runtime DOES
    // have a real abort: the HTTP abort endpoint. Routing '\x1b' there (and
    // ONLY there — every other byte would be a PTY-ism this runtime cannot
    // honor) makes the phone's Stop button and the desktop's Esc actually
    // stop a running turn instead of silently succeeding at nothing, which
    // was the "interrupt is a no-op that reports true" finding.
    //
    // Fire-and-forget: write is synchronous by contract, and an abort that
    // fails over HTTP still surfaces through the SSE api_error channel, so
    // the user is not left without a signal. Any other input is dropped —
    // prompt delivery owns the input path for this runtime.
    if (data === '\x1b' && this.headless) {
      void this.headless.abort().catch(() => {})
    }
  }

  /** No PTY on this structured runtime → no terminal geometry. */
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

/** Narrow an unknown HTTP payload before reading fields off it. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
