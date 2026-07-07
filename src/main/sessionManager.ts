import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { performance } from 'perf_hooks'

import { getMainProvider } from '@providers/registry.main.js'
import { resolveProviderTranscriptPath } from '@main/providerSwitch/shared.js'
import { TerminalSession } from '@shared/runtime/terminalSession.js'
// WHY the manager no longer imports ScreenSnapshot from
// @providers/claude/runtime/claudeSession or JsonlEntry from
// claude-code-headless: those Claude-provider imports inverted the
// dependency arrow — the manager (provider-neutral by contract) knew
// Claude's types by name and dragged them into every downstream
// consumer's type graph. Phase 2a moves the wire shapes to
// @shared/types/session.ts as neutral homes (AgentScreenSnapshot /
// AgentTranscriptEntry). Same runtime payloads, no import arrow into
// a provider. See #394 phase 2a.
import type {
  AgentSession,
  AgentScreenSnapshot,
  AgentTranscriptEntry,
  AgentTrustDialogState,
  AgentResumePromptState,
  AgentPermissionPromptState,
  AgentCompactionState,
  AgentProcessState,
} from '@shared/types/session.js'
import { TmuxRegistry } from '@main/tmux/TmuxRegistry.js'
import { performanceService } from '@main/performance/PerformanceService.js'
import { getToolPath } from '@main/setup/toolchain.js'
import { forgetFeedDebugSession } from '@main/storage/feedDebugLog.js'
import type {
  ConditionCustomAction,
  ProviderConditionSnapshot,
} from '@shared/types/providerConditions.js'
import {
  DEFAULT_PROVIDER,
  isAgentProviderKind,
  type AgentProviderKind,
  type SessionKind,
} from '@shared/types/providerKind.js'
import type { BuiltInMcpDomain, BuiltInMcpServerConfig } from '@mcp/shared/types.js'
import type { BuiltInMcpHttpHost } from '@mcp/runtime/BuiltInMcpHttpHost.js'
import type { AppRunJournal } from '@main/incident/AppRunJournal.js'
import type {
  SessionSpawnOptions,
  SessionSpawnResult,
} from '@preload/api/types.js'

// SessionManager: a thin registry on top of ClaudeSession / TerminalSession
// that lets the main process run N sessions in parallel. Every event
// every session emits is re-emitted here with the sessionId attached,
// so the Electron IPC forwarder can attach one listener per channel
// instead of N×channels.
//
// Why not just use a plain Map<id, ClaudeSession> and attach listeners
// directly from main/index.ts:
//   - main/index.ts would need to re-subscribe every time a session is
//     spawned, and unsubscribe on kill, doubling the bookkeeping.
//   - The forwarder would have to multiplex events from N sessions into
//     one IPC channel per event type anyway — the mux belongs here where
//     it's testable in isolation.
//
// Multi-kind support: Agent Code can host two kinds of sessions per pane
// today — a Claude Code session (ClaudeSession) or a plain shell
// terminal (TerminalSession). The registry holds a union; spawn()
// dispatches on options.kind; events from both are funnelled through
// the same ManagerEvents map with a 'kind' tag on each payload so the
// IPC forwarder can emit them on kind-specific channels if it wants
// (today the renderer just checks the kind on its side).

// SessionKind is the shared provider/session-kind source of truth
// (@shared/types/providerKind). Re-exported here because MCP runtime
// imports `SessionKind` from `@main/sessionManager`; keeping the
// re-export preserves that import path while removing the duplicate
// inline union that used to drift from preload/renderer copies.
export type { SessionKind } from '@shared/types/providerKind.js'

// WHY private: this is the EventEmitter event map for SessionManager.
// It's used internally to type `on()`/`off()`/`emit()` overloads (see
// the `SessionManager` interface below), but no external file imports
// the bare type. Keeping it module-private documents the API surface:
// callers consume the manager through the `SessionManager` interface,
// not via direct event-map type access.
type ManagerEvents = {
  started: [{ sessionId: string; kind: SessionKind; projectDir?: string }]
  'pty-data': [{ sessionId: string; data: string }]
  /** Raw PTY bytes for an attached agent inline terminal. Emitted
   *  only after attachAgentPty() flips the per-session attach flag. */
  'agent-pty-data': [{ sessionId: string; data: string }]
  /** Scraped TUI snapshot from a PTY-backed provider. Claude and
   *  Codex both fire this; a future API-only provider (opencode) won't. */
  screen: [{ sessionId: string } & AgentScreenSnapshot]
  /** Parsed transcript entry from a JSONL/rollout-backed provider.
   *  Payload shape is provider-defined (`Record<string, unknown>` at
   *  this seam); the renderer narrows by shape. See the transcript-
   *  entry-codec plan in #394 phase 2b — this seam is what promotes
   *  it onto the registry. */
  'jsonl-entry': [{ sessionId: string; entry: AgentTranscriptEntry; file: string }]
  'jsonl-error': [{ sessionId: string; error: Error }]
  'process-state': [{ sessionId: string; active: boolean; status?: string }]
  'trust-dialog': [{ sessionId: string; visible: boolean; workspace?: string }]
  'resume-prompt': [{
    sessionId: string
    visible: boolean
    sessionAgeText?: string
    tokenCountText?: string
    options?: string[]
    selectedIndex?: number
  }]
  'permission-prompt': [{
    sessionId: string
    visible: boolean
    title?: string
    toolName?: string
    command?: string
    options?: Array<{ key: string; label: string }>
    selectedIndex?: number
  }]
  'compaction-state': [{
    sessionId: string
    visible: boolean
    phase?: 'running' | 'error' | 'done'
    statusText?: string
    errorText?: string
  }]
  conditions: [{ sessionId: string; snapshot: ProviderConditionSnapshot }]
  /** Emitted only by terminal sessions — raw PTY output for xterm.js. */
  'terminal-data': [{ sessionId: string; data: string }]
  /** Emitted by agent providers that expose a semantic stream — currently
   *  BOTH Claude and Codex (this comment used to say "only by Claude", which is
   *  stale: CodexSession forwards semantic events too, see codexSession's
   *  'semantic-event' forwarding). Per-block stream, proxy-driven for Claude
   *  (or screen-fallback turn-level deltas without `useProxy`) and rollout/proxy
   *  derived for Codex. Payload is a provider discriminated union — see
   *  EVENT_SPEC.md. Forwarded as `unknown` at this layer ON PURPOSE: the manager
   *  is provider-agnostic and must NOT couple to one provider's schema; the
   *  renderer narrows by `ev.type`. */
  'semantic-event': [{ sessionId: string; event: unknown }]
  /** Internal cleanup signal emitted exactly before a session leaves the manager. */
  removed: [{ sessionId: string }]
  exit: [{ sessionId: string; exitCode: number; signal?: number }]
}

type PtySize = { cols: number; rows: number }

export interface SessionManager {
  on<K extends keyof ManagerEvents>(
    event: K,
    listener: (...args: ManagerEvents[K]) => void,
  ): this
  off<K extends keyof ManagerEvents>(
    event: K,
    listener: (...args: ManagerEvents[K]) => void,
  ): this
  emit<K extends keyof ManagerEvents>(
    event: K,
    ...args: ManagerEvents[K]
  ): boolean
}

// The provider session contract now lives at @shared/types/session.ts
// as `AgentSession` (with a typed event map + strictly typed
// on/off/emit interface). The manager just references it; each
// provider runtime DECLARES conformance where it's defined, so a
// missing event/method surfaces as a compile error in the provider,
// not silently at runtime here.
//
// Historical shape kept in the git log: this was `AgentSessionLike`, a
// duck-type with `on(event: string, listener: (...args: never[]) => void)`
// — permissive to the point of enforcing nothing. See #394 phase 2a
// for the migration rationale.
//
// Local aliases used below just narrow AgentSession for the
// duck-typed-optional-method call sites (awaitPastePlaceholder,
// awaitReadyForPrompt), so the callers keep reading naturally.
type AgentSessionLike = AgentSession

// Internal registry shape: we store the concrete instance plus its
// kind so kill/write/resize can dispatch without sniffing the object.
// The registry holds concrete session instances. Agent sessions
// (claude, codex) are created via the provider registry; terminal
// sessions are handled directly.
type RegistryEntry =
  | { kind: AgentProviderKind; session: AgentSessionLike }
  | { kind: 'terminal'; session: TerminalSession; tmuxName: string | null }

// Rolling buffer cap for terminal replay. 256 KB is enough to hold
// the recent scrollback of a normal interactive shell session —
// well beyond "the shell prompt and a few commands ago" which is
// the actual requirement. Past the cap we keep the tail (newest
// content wins) so long-running shells don't blow up memory.
const TERMINAL_BUFFER_CAP = 256 * 1024

// Raw-agent terminal buffer cap. This is intentionally larger than the
// plain terminal cap because Claude/Codex TUIs emit more repaint bytes
// than a normal shell: full-screen redraws, ANSI cursor movement, and
// progress rows can churn heavily even when the visible content is
// small. We still cap aggressively because this buffer is debug-only
// replay state, not the durable transcript source of truth.
const AGENT_PTY_BUFFER_CAP = 512 * 1024

export type ResolveConditionResult =
  | { ok: true; state?: unknown }
  | {
      ok: false
      reason:
        | 'timeout'
        | 'aborted'
        | 'invalid-payload'
        | 'option-not-found'
        | 'no-session'
        | 'no-headless'
        | 'no-resolver'
      lastState?: unknown
      failedAtStep?: string
    }

function appendCappedBuffer(prev: string, data: string, cap: number): string {
  let next = prev + data
  if (next.length <= cap) return next

  // Naive slice by string length can split a UTF-16 surrogate pair.
  // xterm will usually recover from a replacement character, but the
  // replay buffer should not introduce corruption at its oldest edge
  // when dropping the whole rune costs only one code unit.
  let startIdx = next.length - cap
  const firstCode = next.charCodeAt(startIdx)
  if (firstCode >= 0xdc00 && firstCode <= 0xdfff) {
    startIdx += 1
  }
  next = next.slice(startIdx)
  return next
}

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, RegistryEntry>()
  private readonly spawningSessionIds = new Set<string>()
  private readonly lastActivityAt = new Map<string, number>()
  // Latest per-session UI-state snapshots, cached at the emit sites below.
  // WHY: consumers that attach mid-flight (the remote mobile companion's
  // SessionFeedSource/RemoteServer — enabled long after sessions started —
  // and any future late subscriber) would otherwise see nothing until the
  // NEXT event: an idle agent redraws no screen, and a condition snapshot
  // only re-emits on change, so a pending permission prompt raised before
  // the subscriber existed would be invisible forever. Cost is one Map.set
  // per event (a reference store, no clone); entries die with the session
  // in cleanupSessionState.
  private readonly lastScreenSnapshot = new Map<string, AgentScreenSnapshot>()
  private readonly lastConditionsSnapshot = new Map<string, ProviderConditionSnapshot>()
  // Durable transcript path per session, cached from the jsonl-entry relay.
  // This is the one main-side key that unlocks history reads for a LIVE
  // session: cwd is provider-constructor-private and the provider session id
  // exists only inside the jsonl lines, but every entry event carries the
  // file it was appended to. Consumed by the remote companion's get-history
  // (see main/remote/RemoteServer.ts); same lifetime as the snapshot caches.
  //
  // KNOWN STALENESS WINDOW: when the provider rolls to a new transcript
  // (claude /clear, or a resume that mints a new provider session id → new
  // jsonl path), this cache points at the PREVIOUS conversation's file until
  // the new conversation writes its first durable line. Main has no earlier
  // roll signal than that first entry. Consumers must therefore treat the
  // served file as advisory: RemoteServer returns the file identity with
  // every history chunk, and the phone's TranscriptStore discards a chunk
  // whose file disagrees with the file its live frames carry.
  private readonly lastTranscriptFile = new Map<string, string>()
  // Spawn-time identity captured for LATE resolution. The transcript-file
  // cache above starts empty every app run, but RESUMED sessions have a
  // durable transcript on disk from the moment they spawn — main just needs
  // {cwd, resumeSessionId} to re-derive its path via the provider resolver.
  // Without this, the remote companion's history backfill returned nothing
  // for every restored session until it wrote a NEW line (field bug: "still
  // just dumping the raw terminal" after an app restart). cwd doubles as
  // the human-readable workspace label for the remote session list — the
  // 'started' event's projectDir is the TRANSCRIPT directory for Claude,
  // not the workspace the user thinks of.
  private readonly spawnInfo = new Map<
    string,
    { cwd: string; resumeSessionId: string | null }
  >()
  private readonly sessionSizes = new Map<string, PtySize>()
  // Coalesce "input write to a session main doesn't own" incidents — the
  // restored-agents-null bug can make a renderer spam writes against a stale id,
  // so we journal the FIRST miss per session id and then stay quiet.
  private readonly inputWriteFailedReported = new Set<string>()
  // Every session id main has EVER owned (bounded FIFO). Used to tell the
  // restored-agents-null bug (a write to an id we never owned) apart from the
  // benign, documented race (a late write arriving after a session we DID own
  // exited). Only the former is a real incident — without this, normal agent
  // teardown with an in-flight keystroke would cry wolf with an error incident.
  private readonly everKnownSessionIds = new Set<string>()

  // Optional tmux backing for terminal sessions. Constructed by the
  // app entrypoint AFTER detectAvailability() has resolved — we only
  // accept a registry that is known to be usable, so a non-null value
  // here means tmux IS installed. When null, terminal sessions fall
  // back to direct PTY spawn (no persistence).
  constructor(
    private readonly tmuxRegistry: TmuxRegistry | null = null,
    private readonly builtInMcpHost: BuiltInMcpHttpHost | null = null,
    // Always-on incident journal. Optional so tests / non-journaled callers
    // still construct cleanly; null-guarded at every use.
    private readonly journal: AppRunJournal | null = null,
  ) {
    super()
  }

  // Terminal attach/replay state.
  //
  // Why: when the renderer opens a new terminal pane, the sequence
  // is (1) spawn the session on the main side, (2) IPC invoke
  // resolves with sessionId, (3) renderer re-renders, (4)
  // TerminalLeaf mounts, (5) useEffect runs and subscribes to
  // 'session:terminal-data'. Between steps 1 and 5 the shell has
  // already started, sourced its rc files, and printed its prompt —
  // all of which fires as 'data' events on the TerminalSession that
  // reach main before any subscriber exists. Without buffering
  // those events are dropped, and the user sees an empty xterm
  // with a blinking cursor: the shell is waiting for input but
  // there's nothing on screen.
  //
  // Fix is two-part:
  //   - Buffer every byte of PTY output per session in
  //     `terminalBuffers`. Subject to TERMINAL_BUFFER_CAP.
  //   - Only broadcast 'terminal-data' events to the renderer
  //     AFTER the renderer has called attachTerminal(sessionId),
  //     which atomically returns the current buffer AND flips
  //     the attached flag. Before attach, data accumulates in the
  //     buffer silently.
  //
  // The atomic grab-and-attach is critical: if we broadcast while
  // the buffer was still accumulating, the renderer would receive
  // duplicate bytes (once in the buffer, once as a live event).
  // Toggling the flag in the same synchronous tick as the buffer
  // read means no data can slip through between the two.
  private readonly terminalBuffers = new Map<string, string>()
  private readonly terminalAttached = new Set<string>()

  // Agent PTY terminal replay state. Agent sessions already publish
  // parsed screen snapshots to the renderer, which is perfect for the
  // structured feed but not enough for a real inline terminal: xterm
  // needs the raw byte stream, including ANSI cursor movement and full
  // repaint sequences. We therefore keep a capped byte-string replay
  // buffer per Claude/Codex session and expose it only when a raw terminal
  // consumer explicitly attaches (DebugPanel or #247's pane-level terminal
  // mode).
  //
  // This deliberately uses the same attach/replay contract as
  // TerminalLeaf instead of forwarding every agent byte to the
  // renderer from process start: most users never open the raw inline
  // terminal, and agent PTYs can be noisy. Buffer in main, broadcast
  // only after an attach, and let the renderer replay the buffer before
  // draining live bytes.
  private readonly agentPtyBuffers = new Map<string, string>()
  private readonly agentPtyAttachCounts = new Map<string, number>()
  private readonly agentPtyRestoreSizes = new Map<string, PtySize>()

  private markActivity(sessionId: string): void {
    this.lastActivityAt.set(sessionId, Date.now())
  }

  private cleanupSessionState(sessionId: string, kind: SessionKind): void {
    // WHY this helper exists even before the larger SessionState consolidation:
    // per-session state currently lives in several maps whose lifetimes must end
    // together. Keeping all deletes here makes the removal invariant visible and
    // prevents the exact leak class this file had: a new per-session map being
    // added to spawn paths but forgotten in one teardown branch. External
    // resources (JSONL coalescer buffers and subagent watchers) are cleaned by
    // the separate `removed` event so SessionManager does not import forwarder
    // internals.
    this.sessions.delete(sessionId)
    // UI-state snapshot caches die with the session — replaying a dead
    // session's screen/conditions to a late subscriber would present it as
    // live (the exact stale-state bug the remote late-joiner replay had).
    this.lastScreenSnapshot.delete(sessionId)
    this.lastConditionsSnapshot.delete(sessionId)
    this.lastTranscriptFile.delete(sessionId)
    this.spawnInfo.delete(sessionId)
    // Keep lastActivityAt after removal. Process telemetry can be asked about a
    // pane the renderer still knows but whose PTY already exited; deleting this
    // tiny timestamp made those recently-exited panes look like they had never
    // produced activity. Live ownership is `sessions`, not this map, so retaining
    // the timestamp does not keep a process/session alive.
    this.sessionSizes.delete(sessionId)
    if (kind === 'terminal') {
      this.terminalBuffers.delete(sessionId)
      this.terminalAttached.delete(sessionId)
    } else {
      this.agentPtyBuffers.delete(sessionId)
      this.agentPtyAttachCounts.delete(sessionId)
      this.agentPtyRestoreSizes.delete(sessionId)
      this.builtInMcpHost?.revokeSession(sessionId)
    }
    forgetFeedDebugSession(sessionId)
  }

  /**
   * Spawn a new session and return its sessionId. Blocks until the PTY
   * is spawned — after this resolves the caller can immediately start
   * sending input via `write()`.
   *
   * For Claude sessions, start() also attaches the JSONL watcher; for
   * terminal sessions it's just the PTY spawn.
   */
  async spawn(options: SessionSpawnOptions): Promise<SessionSpawnResult> {
    const kind: SessionKind = options.kind ?? DEFAULT_PROVIDER
    const sessionId = options.preferredSessionId ?? randomUUID()
    if (this.sessions.has(sessionId) || this.spawningSessionIds.has(sessionId)) {
      throw new Error(`Session ${sessionId} is already live`)
    }
    // WHY reserve before any provider/tmux await: restored sessions can be
    // woken by attach, send, and orchestration at almost the same time. The
    // renderer single-flights the common path, but main still has to defend the
    // invariant because IPC callers are not all in the same React closure. The
    // terminal tmux path awaited sessionExists/createSession before registering
    // the RegistryEntry, which left a small duplicate-spawn window during
    // restart wake. This reservation makes "spawning" observable to every
    // concurrent caller without pretending the backend is ready yet.
    this.spawningSessionIds.add(sessionId)
    this.spawnInfo.set(sessionId, {
      cwd: options.cwd,
      resumeSessionId: options.resumeSessionId ?? null,
    })
    try {
    const spawnStartedAt = performance.now()
    performanceService.mark('session.spawn.start', {
      sessionId,
      kind,
      resume: Boolean(options.resumeSessionId),
      useProxy: Boolean(options.useProxy),
    })

    // Agent providers (claude, codex) — dispatched through the registry.
    // Both providers emit the same event shape (started, pty-data,
    // screen, jsonl-entry, jsonl-error, exit), so the wiring is
    // identical. The registry handles which concrete session class to
    // instantiate. This eliminates the if/else duplication that caused
    // cross-provider breakage when editing one provider's spawn logic.
    // isAgentProviderKind, not a literal pair: this is the agent-vs-
    // terminal spawn dispatch. With the literal pair, a registered
    // third provider silently fell through and spawned a PLAIN SHELL
    // (#394 §4.1 — the worst of the silent failure modes).
    if (isAgentProviderKind(kind)) {
      const initialSize = {
        cols: options.cols ?? 120,
        rows: options.rows ?? 40,
      }
      let builtInMcpServers: BuiltInMcpServerConfig[] = []
      if (options.builtInMcpDomains && options.builtInMcpDomains.length > 0) {
        if (!this.builtInMcpHost) {
          throw new Error('Built-in MCP host is not available')
        }
        builtInMcpServers = this.builtInMcpHost.registerSession({
          sessionId,
          cwd: options.cwd,
          domains: options.builtInMcpDomains,
        })
      }
      const provider = getMainProvider(kind)
      const createStartedAt = performance.now()
      // `session` here structurally conforms to AgentSessionLike —
      // every provider that registers through the registry is
      // contracted to expose start/stop/write/resize + the standard
      // 'started'/'pty-data'/'screen'/'jsonl-entry'/'jsonl-error'/
      // 'process-state'/'conditions'/'semantic-event'/'exit' events. We use
      // a narrow structural cast so provider-specific implementation
      // details don't leak into the manager.
      const session = provider.createSession({
        cwd: options.cwd,
        binary: getToolPath(kind, kind),
        cols: initialSize.cols,
        rows: initialSize.rows,
        // 100ms (~10Hz), NOT the old 16ms (~60Hz). The 'screen'
        // snapshot pipeline is a parsing/monitoring surface, not a
        // display path — the visible terminal renders from raw
        // pty-data. At 16ms every live session built four buffer
        // serializations per tick (two of them per-cell markdown
        // walks over ~200 rows), ran all screen parsers, and shipped
        // four strings over IPC; with ~10 concurrent sessions that
        // allocated hundreds of MB/s of garbage in main and the V8
        // major-GC storm pinned ~80% CPU with heapUsed oscillating
        // 46MB↔1.2GB (#390 has the full trace-driven diagnosis).
        //
        // Kept EXPLICIT (not omitted) deliberately: the pinned
        // headless submodule commits still default to 16 internally
        // until the pointer bumps for claude-code-headless#32 /
        // codex-headless#24 land, and an explicit value here keeps
        // the app-side cadence independent of which submodule
        // revision is checked out. Those PRs also add a change gate
        // that skips identical frames entirely — the two fixes
        // compose.
        snapshotIntervalMs: 100,
        resumeSessionId: options.resumeSessionId,
        dangerousMode: options.dangerousMode,
        shellSessionId: sessionId,
        // Agent providers both accept `useProxy`. Claude uses the
        // mitmproxy path; Codex uses a local Responses proxy via
        // `openai_base_url`.
        useProxy: options.useProxy,
        builtInMcpServers,
      })
      // No cast: createSession's return type is now AgentSession, so
      // any provider whose runtime drifts from the contract fails
      // compilation inside the provider (registry.main.ts's
      // Record<AgentProviderKind, MainProviderConfig> forces it). See
      // #394 phase 2a.
      performanceService.record({
        kind: 'span_end',
        process: 'main',
        area: 'session.spawn',
        name: 'session.spawn.providerCreate',
        durationMs: performance.now() - createStartedAt,
        sessionId,
        provider: kind,
      })

      this.sessionSizes.set(sessionId, initialSize)
      this.agentPtyBuffers.set(sessionId, '')
      session.on('started', ({ projectDir }) => {
        this.markActivity(sessionId)
        this.emit('started', { sessionId, kind, projectDir })
      })
      session.on('pty-data', (data: string) => {
        this.markActivity(sessionId)
        const prev = this.agentPtyBuffers.get(sessionId) ?? ''
        this.agentPtyBuffers.set(
          sessionId,
          appendCappedBuffer(prev, data, AGENT_PTY_BUFFER_CAP),
        )
        if ((this.agentPtyAttachCounts.get(sessionId) ?? 0) > 0) {
          this.emit('agent-pty-data', { sessionId, data })
        }
        this.emit('pty-data', { sessionId, data })
      })
      session.on('screen', (snap: AgentScreenSnapshot) => {
        this.markActivity(sessionId)
        this.lastScreenSnapshot.set(sessionId, snap)
        this.emit('screen', { sessionId, ...snap })
      })
      session.on('jsonl-entry', (entry: AgentTranscriptEntry, file: string) => {
        this.markActivity(sessionId)
        this.lastTranscriptFile.set(sessionId, file)
        this.emit('jsonl-entry', { sessionId, entry, file })
      })
      session.on('jsonl-error', (error: Error) => {
        this.markActivity(sessionId)
        this.emit('jsonl-error', { sessionId, error })
      })
      session.on('process-state', (state: AgentProcessState) => {
        this.markActivity(sessionId)
        this.emit('process-state', { sessionId, ...state })
      })
      session.on('trust-dialog', (state: AgentTrustDialogState) => {
        this.markActivity(sessionId)
        this.emit('trust-dialog', { sessionId, ...state })
      })
      session.on('resume-prompt', (state: AgentResumePromptState) => {
        this.markActivity(sessionId)
        this.emit('resume-prompt', { sessionId, ...state })
      })
      session.on('permission-prompt', (state: AgentPermissionPromptState) => {
        this.markActivity(sessionId)
        this.emit('permission-prompt', { sessionId, ...state })
      })
      session.on('compaction-state', (state: AgentCompactionState) => {
        this.markActivity(sessionId)
        this.emit('compaction-state', { sessionId, ...state })
      })
      session.on('conditions', (snapshot: ProviderConditionSnapshot) => {
        this.markActivity(sessionId)
        this.lastConditionsSnapshot.set(sessionId, snapshot)
        this.emit('conditions', { sessionId, snapshot })
      })
      session.on('semantic-event', (event: unknown) => {
        this.markActivity(sessionId)
        this.emit('semantic-event', { sessionId, event })
      })
      session.on('exit', ({ exitCode, signal }: { exitCode: number; signal?: number }) => {
        this.markActivity(sessionId)
        this.emit('removed', { sessionId })
        this.emit('exit', { sessionId, exitCode, signal })
        this.cleanupSessionState(sessionId, kind)
      })

      this.sessions.set(sessionId, { kind, session })
      this.rememberSessionId(sessionId)
      try {
        const startStartedAt = performance.now()
        await session.start()
        performanceService.record({
          kind: 'span_end',
          process: 'main',
          area: 'session.spawn',
          name: 'session.spawn.providerStart',
          durationMs: performance.now() - startStartedAt,
          sessionId,
          provider: kind,
        })
      } catch (err) {
        // Same shape as the terminal path below: start() failure must
        // not leave a dead entry in the registry. The listeners we
        // attached above will never fire again (the session didn't
        // start), so removing the registry row is enough to let GC
        // collect the whole graph. We do NOT call removeAllListeners
        // on `session` because the wrapper already owns its own
        // EventEmitter — nothing outside the registry subscribed.
        if (this.sessions.has(sessionId)) this.emit('removed', { sessionId })
        this.cleanupSessionState(sessionId, kind)
        performanceService.error('session.spawn.providerStart.error', err, {
          sessionId,
          kind,
        })
        throw err
      }
      performanceService.record({
        kind: 'span_end',
        process: 'main',
        area: 'session.spawn',
        name: 'session.spawn.total',
        durationMs: performance.now() - spawnStartedAt,
        sessionId,
        provider: kind,
      })
      return { sessionId }
    }

    // kind === 'terminal'
    //
    // Tmux backing is opt-in based on registry availability. When the
    // registry says yes, we either reuse an existing tmux session
    // (recovery path — `recoverTmuxName` was passed and the session
    // is alive) or create a fresh one. When tmux is unavailable, fall
    // through to the direct PTY path that's existed since day one.
    const useTmux = this.tmuxRegistry?.isAvailable() === true
    let tmuxSessionName: string | null = null
    if (useTmux) {
      const tmuxStartedAt = performance.now()
      const reg = this.tmuxRegistry!
      const recoveredTmux = options.recoverTmuxName
        ? await reg.sessionExists(options.recoverTmuxName)
        : false
      if (options.recoverTmuxName && recoveredTmux) {
        // Reattach path — tmux owned this session through the previous
        // Agent Code launch and it's still alive. Reuse the name; do
        // NOT createSession (that would error or duplicate).
        tmuxSessionName = options.recoverTmuxName
      } else {
        tmuxSessionName = reg.generateName()
        await reg.createSession({
          name: tmuxSessionName,
          command: process.env.SHELL ?? '/bin/zsh',
          cwd: options.cwd,
        })
      }
      performanceService.record({
        kind: 'span_end',
        process: 'main',
        area: 'session.spawn',
        name: 'session.spawn.tmuxPrepare',
        durationMs: performance.now() - tmuxStartedAt,
        sessionId,
        provider: 'terminal',
        data: { recovered: recoveredTmux },
      })
    }

    const initialSize = {
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
    }

    // WHY we thread the registry's binary through to TerminalSession:
    //   TerminalSession's tmux runtime spawns `tmux attach -t <name>`,
    //   so it needs to point at the SAME binary the registry just
    //   used to `new-session` the target. Under the bundled-only
    //   policy (see src/main/index.ts), PATH-resolved `tmux` could be
    //   a different version with an incompatible session format —
    //   using one tmux to create and another to attach would
    //   silently fail or, worse, partially work. The registry is the
    //   source of truth.
    //
    //   When useTmux is true the registry must have a binary (the
    //   `isAvailable()` gate above only flips true after
    //   `detectAvailability()` confirmed one), so the null coalesce
    //   below is defensive against future code paths that bypass
    //   that gate.
    const registryBinary = this.tmuxRegistry?.getBinary() ?? undefined
    const session = new TerminalSession({
      cwd: options.cwd,
      cols: initialSize.cols,
      rows: initialSize.rows,
      runtime: useTmux ? 'tmux' : 'direct',
      tmuxSessionName: tmuxSessionName ?? undefined,
      tmuxBinary: useTmux ? registryBinary : undefined,
    })

    // Initialize an empty buffer entry NOW, before start() fires any
    // data events. The buffer accumulates every byte of PTY output
    // and is replayed to the renderer on attach — see the block
    // comment on terminalBuffers above for the full reasoning.
    this.sessionSizes.set(sessionId, initialSize)
    this.terminalBuffers.set(sessionId, '')

    // Terminal sessions only emit started / data / exit. The 'data'
    // event carries raw PTY bytes for xterm.js on the renderer side;
    // we forward it on a dedicated 'terminal-data' channel so the
    // renderer can route it straight to xterm without the code path
    // for Claude's structured events getting involved.
    session.on('started', () =>
      {
        this.markActivity(sessionId)
        this.emit('started', { sessionId, kind, projectDir: undefined })
      },
    )
    session.on('data', data => {
      this.markActivity(sessionId)
      // Always append to the rolling buffer so a later attach can
      // replay the full history. Cap at TERMINAL_BUFFER_CAP —
      // longer sessions just lose the oldest bytes, which is the
      // standard terminal scrollback behavior.
      const prev = this.terminalBuffers.get(sessionId) ?? ''
      this.terminalBuffers.set(
        sessionId,
        appendCappedBuffer(prev, data, TERMINAL_BUFFER_CAP),
      )
      // Only broadcast live events AFTER the renderer has attached.
      // Before attach, the data is still in the buffer and will be
      // replayed when the renderer calls attachTerminal. See the
      // block comment on terminalBuffers for why this is
      // race-free.
      if (this.terminalAttached.has(sessionId)) {
        this.emit('terminal-data', { sessionId, data })
      }
    })
    session.on('exit', ({ exitCode, signal }) => {
      this.markActivity(sessionId)
      this.emit('removed', { sessionId })
      this.emit('exit', { sessionId, exitCode, signal })
      this.cleanupSessionState(sessionId, 'terminal')
    })

    this.sessions.set(sessionId, { kind: 'terminal', session, tmuxName: tmuxSessionName })
    this.rememberSessionId(sessionId)
    try {
      const terminalStartStartedAt = performance.now()
      await session.start()
      performanceService.record({
        kind: 'span_end',
        process: 'main',
        area: 'session.spawn',
        name: 'session.spawn.terminalStart',
        durationMs: performance.now() - terminalStartStartedAt,
        sessionId,
        provider: 'terminal',
      })
    } catch (err) {
      // start() can fail if the PTY refuses to spawn or (on the tmux
      // path) the tmux server dies between createSession and attach.
      // Without cleanup here, the terminalBuffers entry we set up
      // pre-start stays forever (no 'exit' event will fire for a
      // session that never started), and the registry row points at
      // a half-dead TerminalSession that callers might still try to
      // write()/resize()/kill(). Roll back everything we added in
      // THIS spawn so the caller can retry from a clean slate.
      if (this.sessions.has(sessionId)) this.emit('removed', { sessionId })
      this.cleanupSessionState(sessionId, 'terminal')
      performanceService.error('session.spawn.terminalStart.error', err, { sessionId })
      throw err
    }
    performanceService.record({
      kind: 'span_end',
      process: 'main',
      area: 'session.spawn',
      name: 'session.spawn.total',
      durationMs: performance.now() - spawnStartedAt,
      sessionId,
      provider: 'terminal',
    })
    return { sessionId, tmuxName: tmuxSessionName ?? undefined }
    } finally {
      this.spawningSessionIds.delete(sessionId)
    }
  }

  /**
   * Terminal attach/replay entry point.
   *
   * Called by the renderer when a TerminalLeaf mounts and wants to
   * hook up its xterm.js instance to an already-running terminal
   * session. Returns the current output buffer AND flips the
   * attached flag, both synchronously in the same tick so no PTY
   * data can slip between the two operations.
   *
   * Usage from the renderer (see TerminalLeaf.tsx):
   *   1. Subscribe to 'session:terminal-data' first so no events
   *      after attach are missed.
   *   2. Call attachTerminal(sessionId); write returned buffer to
   *      xterm. Any live events that arrived between subscribe and
   *      this point must be queued and written AFTER the buffer —
   *      see the queue logic in TerminalLeaf.
   *   3. Subsequent live events write directly to xterm.
   *
   * Returns '' if the session doesn't exist or isn't a terminal —
   * silently safe so a stale attach call on a dead session doesn't
   * error.
   */
  attachTerminal(sessionId: string): string {
    const entry = this.sessions.get(sessionId)
    if (!entry) {
      // Caller is asking to attach to a session that's already gone.
      // Silent empty-string is fine here; any TerminalLeaf that mounts
      // for a dead session will simply see an empty xterm.
      return ''
    }
    if (entry.kind !== 'terminal') {
      // Kind mismatch is a routing bug — a Claude or Codex pane's
      // leaf is wiring itself into the terminal-data pipeline. Keep
      // returning '' (don't crash the renderer over an assumption
      // mismatch) but warn loudly so the caller sees it in the main
      // process log instead of silently losing data. Without this
      // warn, a regression that sent a terminal attach call to the
      // wrong pane would look like "nothing renders" with no trace.
      console.warn(
        `[SessionManager] attachTerminal called on non-terminal session`,
        { sessionId, kind: entry.kind },
      )
      return ''
    }
    const buffer = this.terminalBuffers.get(sessionId) ?? ''
    // Flip the attach flag in the SAME synchronous block as reading
    // the buffer. JavaScript is single-threaded and event emission
    // can only happen on a later tick, so nothing can sneak in.
    this.terminalAttached.add(sessionId)
    return buffer
  }

  /**
   * Agent PTY attach/replay entry point.
   *
   * This is the Claude/Codex counterpart to attachTerminal(). It is
   * intentionally separate because agent panes are not terminal panes:
   * their primary renderer is the structured feed, while this inline
   * terminal is an opt-in view into the underlying provider TUI.
   * Returning the buffered raw bytes lets the inline xterm reconstruct
   * the provider's latest terminal state, then `agent-pty-data`
   * carries subsequent live bytes for as long as the session remains
   * open.
   *
   * Multiple renderer consumers can attach to the same session (for example a
   * debug panel plus a Tiled Dispatch lane). The attach count is intentionally
   * session-scoped: the first attach captures the provider PTY size to restore
   * later, and the final detach performs that restore. This prevents one
   * unmounted consumer from cutting off live bytes for another still-mounted
   * raw terminal.
   */
  attachAgentPty(sessionId: string): string {
    const entry = this.sessions.get(sessionId)
    if (!entry) return ''
    if (!isAgentProviderKind(entry.kind)) {
      console.warn(
        `[SessionManager] attachAgentPty called on non-agent session`,
        { sessionId, kind: entry.kind },
      )
      return ''
    }
    const buffer = this.agentPtyBuffers.get(sessionId) ?? ''
    const attachCount = this.agentPtyAttachCounts.get(sessionId) ?? 0
    if (attachCount === 0) {
      const currentSize = this.sessionSizes.get(sessionId)
      if (currentSize) {
        this.agentPtyRestoreSizes.set(sessionId, { ...currentSize })
      }
    }
    this.agentPtyAttachCounts.set(sessionId, attachCount + 1)
    return buffer
  }

  /**
   * Detach a raw inline terminal from a Claude/Codex session.
   * The final detach disables raw PTY IPC forwarding and restores the provider
   * PTY size that was active before the first inline terminal took ownership.
   */
  detachAgentPty(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    const attachCount = this.agentPtyAttachCounts.get(sessionId) ?? 0
    if (attachCount > 1) {
      this.agentPtyAttachCounts.set(sessionId, attachCount - 1)
      return
    }
    this.agentPtyAttachCounts.delete(sessionId)
    const restoreSize = this.agentPtyRestoreSizes.get(sessionId)
    this.agentPtyRestoreSizes.delete(sessionId)
    if (!entry || !isAgentProviderKind(entry.kind)) return
    if (!restoreSize) return
    entry.session.resize(restoreSize.cols, restoreSize.rows)
    this.sessionSizes.set(sessionId, restoreSize)
  }

  /**
   * Write bytes to a session's PTY. Silently no-ops if the session
   * doesn't exist — this happens naturally if a session exits between
   * the renderer queueing input and the main process handling it.
   */
  write(sessionId: string, data: string): boolean {
    const entry = this.sessions.get(sessionId)
    if (!entry) {
      // A silent miss here is brutal to debug from the renderer: the composer
      // clears, the feed may show an optimistic user row, and nothing ever
      // reaches the PTY. Surface the miss to callers so they can log/retain
      // the draft instead of pretending the send succeeded.
      //
      // This is also the durable signal for the "restored agents are null until
      // reload" bug (plan Phase 5): a renderer pane writing to a session id main
      // has no backend for. Journal the FIRST miss per id (coalesced) — but ONLY
      // when the id was NEVER owned. A miss on a once-owned id is the benign race
      // the docstring above describes (session exited between queue and write),
      // not the bug, so we stay silent for it to avoid crying wolf.
      if (
        this.journal &&
        !this.everKnownSessionIds.has(sessionId) &&
        !this.inputWriteFailedReported.has(sessionId)
      ) {
        this.inputWriteFailedReported.add(sessionId)
        if (this.inputWriteFailedReported.size > 256) this.inputWriteFailedReported.clear()
        this.journal.recordIncident({
          kind: 'session.input_write_failed',
          severity: 'error',
          reason: 'backend_session_not_found',
          context: { sessionId, dataLength: data.length },
        })
      }
      return false
    }
    entry.session.write(data)
    return true
  }

  getSessionKind(sessionId: string): SessionKind | null {
    return this.sessions.get(sessionId)?.kind ?? null
  }

  // Record that main owned this session id, for input_write_failed disambiguation.
  private rememberSessionId(sessionId: string): void {
    this.everKnownSessionIds.add(sessionId)
    if (this.everKnownSessionIds.size > 8192) {
      // Bound memory: evict the oldest id (Set preserves insertion order). Evicted
      // ids are long-dead sessions; a late write to one is vanishingly unlikely.
      const oldest = this.everKnownSessionIds.values().next().value
      if (oldest !== undefined) this.everKnownSessionIds.delete(oldest)
    }
  }

  /**
   * Claude-specific accessor for the paste-submit event-driven path
   * in `src/renderer/.../claudePaste.ts`. Returns the live ClaudeSession
   * cast through `unknown` because AgentSessionLike doesn't (and
   * shouldn't) expose `awaitPastePlaceholder` — that's a Claude-only
   * affordance and adding it to the cross-provider interface would
   * force every other runtime to ship a no-op stub.
   *
   * Returns `null` for missing sessions or non-Claude kinds. Callers
   * MUST treat null as a benign "couldn't reach this session" and
   * fall through to whatever non-event-driven path they were using
   * before; the absence of a Claude session is not an error worth
   * crashing over.
   */
  async awaitClaudePastePlaceholder(
    sessionId: string,
    opts?: { timeoutMs?: number; pollIntervalMs?: number },
  ): Promise<
    | { kind: 'appeared'; waitedMs: number }
    | { kind: 'timeout' }
    | { kind: 'no-headless' }
    | { kind: 'no-session' }
  > {
    const entry = this.sessions.get(sessionId)
    if (!entry || entry.kind !== 'claude') return { kind: 'no-session' }
    // The cross-provider AgentSessionLike interface doesn't carry
    // `awaitPastePlaceholder`; ClaudeSession does. We assert via a
    // structural duck-type so misconfigured Claude provider builds
    // (a future ClaudeSession that loses the method) surface as
    // 'no-session' rather than a TypeError.
    // No cast: awaitPastePlaceholder is now a typed optional on
    // AgentSession (see @shared/types/session.ts).
    const session = entry.session
    if (typeof session.awaitPastePlaceholder !== 'function') {
      return { kind: 'no-session' }
    }
    return session.awaitPastePlaceholder(opts)
  }

  async resolveCondition(
    sessionId: string,
    action: ConditionCustomAction,
  ): Promise<ResolveConditionResult> {
    const entry = this.sessions.get(sessionId)
    // ANY agent kind may carry a resolver now (#394 phase 3) — the
    // old `entry.kind !== 'claude'` gate meant a provider that
    // implemented AgentSession.resolveCondition still got a dead-end
    // 'no-session' from the manager (#394 §5). `=== 'terminal'`
    // rather than !isAgentProviderKind because TypeScript only
    // discriminates the RegistryEntry union on literal comparisons.
    // A provider without a resolver (Codex today — its approvals
    // answer via raw keystrokes) hits the capability check below and
    // returns 'no-resolver', which is truthful.
    if (!entry || entry.kind === 'terminal') {
      return { ok: false, reason: 'no-session' }
    }
    if (typeof entry.session.resolveCondition !== 'function') {
      return { ok: false, reason: 'no-resolver' }
    }
    // The AgentSession contract types `reason` as a plain string (a
    // provider defines its own failure vocabulary); the app-side
    // ResolveConditionResult narrows to the known reason set for
    // renderer/IPC consumers. The cast asserts providers keep their
    // reasons within that set — Claude's DriveResult does; a new
    // provider's resolver must too (documented on the contract).
    return entry.session.resolveCondition(action) as Promise<ResolveConditionResult>
  }

  async awaitCodexReadyForPrompt(
    sessionId: string,
    opts?: { timeoutMs?: number; pollIntervalMs?: number },
  ): Promise<
    | { kind: 'ready'; waitedMs: number }
    | { kind: 'timeout' }
    | { kind: 'no-headless' }
    | { kind: 'no-session' }
  > {
    const entry = this.sessions.get(sessionId)
    if (!entry || entry.kind !== 'codex') return { kind: 'no-session' }
    // WHY this mirrors the Claude paste-placeholder escape hatch instead of
    // widening the whole AgentSessionLike contract:
    //
    // Provider startup hazards are different. Claude's race is "paste payload
    // committed but Enter arrived too early"; Codex's race is "PTY exists but
    // the TUI is still on startup/trust chrome and will drop composer input".
    // Keeping both probes provider-specific prevents a fake no-op readiness API
    // from becoming part of every future provider runtime, while still giving
    // orchestration a truthful delivery boundary before it marks a prompt as
    // submitted.
    // No cast: awaitReadyForPrompt is now a typed optional on
    // AgentSession (see @shared/types/session.ts).
    const session = entry.session
    if (typeof session.awaitReadyForPrompt !== 'function') {
      return { kind: 'no-headless' }
    }
    return session.awaitReadyForPrompt(opts)
  }

  /**
   * Deliver a prompt to an agent session using the PROVIDER'S OWN
   * delivery protocol (#394 phase 2c).
   *
   * WHY this lives on the manager instead of MCP calling the registry
   * directly: the provider implementations need the live AgentSession
   * object plus a liveness-aware write, and both are manager-owned
   * state. MCP (and any future caller — composer flows, dispatch)
   * gets one provider-agnostic entry point; the per-provider
   * discipline (Codex readiness-gate + atomic paste+Enter, Claude
   * paste → placeholder confirm → Enter) lives in
   * providers/<kind>/runtime/promptDelivery.ts.
   *
   * An unknown/non-agent kind is a LOUD failure — the predecessor
   * inline branches let a third provider fall through to a
   * protocol-free paste with no readiness gate and no confirmation
   * (#394 §4.2).
   */
  async deliverPromptToAgent(
    sessionId: string,
    prompt: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const entry = this.sessions.get(sessionId)
    // `=== 'terminal'` rather than !isAgentProviderKind: TypeScript
    // only discriminates the RegistryEntry union on literal kind
    // comparisons, and we need `entry.session` narrowed to
    // AgentSession for the registry call below.
    if (!entry || entry.kind === 'terminal') {
      return {
        ok: false,
        message: `Cannot deliver prompt: ${sessionId} is not a live agent session`,
      }
    }
    return getMainProvider(entry.kind).deliverPrompt({
      session: entry.session,
      write: data => this.write(sessionId, data),
      sessionId,
      prompt,
    })
  }

  /** Resize a session's terminal + PTY. No-op if session doesn't exist. */
  resize(sessionId: string, cols: number, rows: number): void {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    entry.session.resize(cols, rows)
    this.sessionSizes.set(sessionId, { cols, rows })
  }

  /**
   * Kill a session and remove it from the registry. Returns true if
   * the session existed and was killed.
   */
  async kill(sessionId: string): Promise<boolean> {
    const entry = this.sessions.get(sessionId)
    if (!entry) return false
    await entry.session.stop()
    // Belt-and-suspenders listener cleanup.
    //
    // The spawn() path attaches ~10 listeners to the underlying
    // session EventEmitter (started / pty-data / screen / jsonl-entry
    // / …). Those listeners are removed naturally when `exit` fires
    // and we `this.sessions.delete(sessionId)` — the EventEmitter
    // becomes unreachable and gets GC'd.
    //
    // But if a provider's stop() resolves WITHOUT ever emitting
    // 'exit' (observed on some Codex error paths and in any future
    // runtime that's sloppy about the contract), the session object
    // is still alive, still referenced by closures inside those
    // listeners, and holds open all its internal state — effectively
    // a slow memory leak that accumulates across session churn.
    //
    // removeAllListeners() on the session object breaks the closure
    // graph, and we do it unconditionally so the leak class is
    // impossible regardless of which provider emits exit and which
    // doesn't. Safe even if exit later fires: the registry has
    // already deleted the entry, so the exit handler's
    // `this.sessions.delete` is a no-op.
    // Both AgentSessionLike and TerminalSession (an EventEmitter
    // subclass) expose removeAllListeners — typed as optional on the
    // agent interface because we don't want to mandate it contractually,
    // just use it when present.
    try {
      const maybe = (entry.session as { removeAllListeners?: () => void })
        .removeAllListeners
      maybe?.call(entry.session)
    } catch { /* best-effort */ }
    // For tmux-backed terminals, stop() detaches the client but
    // intentionally leaves the tmux session alive so undo-close can
    // re-attach to it (scrollback intact, environment intact, any
    // long-running process still running). The eventual GC happens
    // on next app launch via tmuxRecovery — when a session is closed
    // and the user never undoes, it falls out of workspace.json, and
    // launch-time reconcile() classifies the still-alive tmux as an
    // orphan and kills it. This is the explicit "buffer for undo"
    // behavior the user asked for in the P1 brainstorm.
    if (this.sessions.get(sessionId) !== entry) {
      // stop() emitted exit synchronously and the exit handler already emitted
      // `removed` + cleaned every map. Returning here avoids a second final JSONL
      // flush / subagent-stop from the explicit kill path.
      return true
    }
    this.emit('removed', { sessionId })
    this.cleanupSessionState(sessionId, entry.kind)
    return true
  }

  getProcessTelemetryTargets(sessionIds?: string[]): Array<{
    sessionId: string
    kind: SessionKind
    pid: number | null
    exited: boolean
    lastActivityAt: number | null
  }> {
    const ids = sessionIds ?? Array.from(this.sessions.keys())
    return ids.map(sessionId => {
      const entry = this.sessions.get(sessionId)
      if (!entry) {
        return {
          sessionId,
          kind: 'terminal' as SessionKind,
          pid: null,
          exited: true,
          lastActivityAt: this.lastActivityAt.get(sessionId) ?? null,
        }
      }
      // getProcessPid / isExited are typed optionals on AgentSession
      // (and on TerminalSession's structural surface); no cast needed.
      const s = entry.session
      return {
        sessionId,
        kind: entry.kind,
        pid: s.getProcessPid?.() ?? null,
        exited: s.isExited?.() === true,
        lastActivityAt: this.lastActivityAt.get(sessionId) ?? null,
      }
    })
  }

  /** List all live session ids. Used for state save / debug. */
  list(): string[] {
    return Array.from(this.sessions.keys())
  }

  /** Latest screen snapshot observed for a live session, or null before the
   *  first frame. See the cache fields' WHY comment — this exists for
   *  late-attaching consumers (remote companion) to seed their state. */
  getScreenSnapshot(sessionId: string): AgentScreenSnapshot | null {
    return this.lastScreenSnapshot.get(sessionId) ?? null
  }

  /** Latest provider-conditions snapshot for a live session, or null if no
   *  condition has ever been live. Same late-attach rationale as
   *  getScreenSnapshot. */
  getConditionsSnapshot(sessionId: string): ProviderConditionSnapshot | null {
    return this.lastConditionsSnapshot.get(sessionId) ?? null
  }

  /** Durable transcript file for a live session, or null before the first
   *  jsonl entry has been observed. See the cache field's WHY. */
  getTranscriptFile(sessionId: string): string | null {
    return this.lastTranscriptFile.get(sessionId) ?? null
  }

  /**
   * Transcript file with a resume-aware fallback: when no jsonl entry has
   * been observed THIS app run (the common state for every restored session
   * right after a restart), a resumed session's transcript is re-derived
   * from its spawn-time {cwd, resumeSessionId} through the same provider
   * resolver history loading uses. Fresh sessions genuinely have no
   * transcript until their first entry — null is correct for them.
   */
  async resolveTranscriptFile(sessionId: string): Promise<string | null> {
    const observed = this.lastTranscriptFile.get(sessionId)
    if (observed) return observed
    const info = this.spawnInfo.get(sessionId)
    const kind = this.getSessionKind(sessionId)
    if (!info?.resumeSessionId || !kind || kind === 'terminal') return null
    try {
      return await resolveProviderTranscriptPath({
        kind,
        cwd: info.cwd,
        providerSessionId: info.resumeSessionId,
      })
    } catch {
      // Resolution is best-effort: a missing project dir or unreadable
      // sessions root should degrade to "no history yet", not break the
      // caller's reply path.
      return null
    }
  }

  /** Workspace cwd captured at spawn — the label a session list should
   *  show (the 'started' event's projectDir is provider-internal). */
  getSpawnCwd(sessionId: string): string | null {
    return this.spawnInfo.get(sessionId)?.cwd ?? null
  }

  /** Epoch ms of the last observed activity (any relayed session event). */
  getLastActivityAt(sessionId: string): number | null {
    return this.lastActivityAt.get(sessionId) ?? null
  }

  /** Kill every live session. Called on app quit. */
  async killAll(): Promise<void> {
    const ids = this.list()
    await Promise.all(ids.map(id => this.kill(id)))
  }
}
