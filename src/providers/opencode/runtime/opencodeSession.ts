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

import {
  OpencodeHeadless,
  type CommittedEntryEvent,
  type ScreenActivityEvent,
  type SemanticEvent,
} from 'opencode-headless'
import type {
  AgentSession,
  AgentSessionEvents,
  AgentTranscriptEntry,
  SessionOptions,
} from '@shared/types/session.js'

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
    // initial resume replay AND live turn commits). The mapper (step 4)
    // turns each into feed entries; today the stub maps nothing, but the
    // semantic streaming card already renders live turns off the
    // semantic channel below, so a fresh pane is not blank.
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

    // NOTE: permission/question screen events → `conditions` snapshot is
    // step 6 (the condition views + runtime folding). Deliberately not
    // wired here so step 3 stays "a pane spawns and streams".

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

  /** Deliver a text prompt over HTTP. Public so the opencode
   *  deliverPrompt protocol (step 5) can reach opencode's prompt() call
   *  without the registry knowing opencode's transport. Throws if the
   *  session hasn't started (no server URL / SyncClient yet). */
  async sendPrompt(text: string): Promise<void> {
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
