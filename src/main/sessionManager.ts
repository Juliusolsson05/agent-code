import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { performance } from 'perf_hooks'

import { getMainProvider } from '@providers/registry.main.js'
import type { ScreenSnapshot } from '@providers/claude/runtime/claudeSession.js'
import { TerminalSession } from '@shared/runtime/terminalSession.js'
import type { JsonlEntry } from 'claude-code-headless'
import { TmuxRegistry } from '@main/tmux/TmuxRegistry.js'
import { performanceService } from '@main/performance/PerformanceService.js'
import { getToolPath } from '@main/setup/toolchain.js'
import { forgetFeedDebugSession } from '@main/storage/feedDebugLog.js'
import type { ProviderConditionSnapshot } from '@shared/types/providerConditions.js'

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

export type SessionKind = 'claude' | 'codex' | 'terminal'

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
  /** Emitted only by Claude sessions — the scraped TUI snapshot. */
  screen: [{ sessionId: string } & ScreenSnapshot]
  /** Emitted only by Claude sessions — parsed JSONL entries. */
  'jsonl-entry': [{ sessionId: string; entry: JsonlEntry; file: string }]
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
  /** Emitted only by Claude sessions. Proxy-driven per-block semantic
   *  stream (or screen-fallback turn-level deltas when the session
   *  was spawned without `useProxy`). Payload is a discriminated
   *  union from claude-code-headless — see EVENT_SPEC.md and the
   *  `SemanticEvent` type there. Forwarded as `unknown` at this layer
   *  because the manager is deliberately provider-agnostic; the
   *  renderer narrows by `ev.type`. */
  'semantic-event': [{ sessionId: string; event: unknown }]
  exit: [{ sessionId: string; exitCode: number; signal?: number }]
}

// WHY private: SpawnOptions is the argument shape for the spawn()
// method on this class. No external file types its own spawn() wrapper
// in terms of this — IPC handlers convert from their JSON-RPC payload
// shapes inline. Privatizing prevents accidental cross-module coupling
// to a type that will keep evolving alongside spawn() internals.
type SpawnOptions = {
  /** Which kind of session to spawn. Defaults to 'claude' so the
   *  pre-existing call sites keep working without a kind arg. */
  kind?: SessionKind
  cwd: string
  cols?: number
  rows?: number
  /** Claude only: if set, spawn with --resume <uuid> and tail the
   *  existing session file. Silently ignored for terminal sessions. */
  resumeSessionId?: string
  /** Agent sessions only: opt into provider-specific dangerous mode. */
  dangerousMode?: boolean
  /** Claude only: opt into proxy-driven semantic streaming. Default
   *  false — screen parsing stays the semantic source and no
   *  mitmproxy process is spawned. When true, ClaudeSession spawns a
   *  per-session mitmproxy, launches Claude through it with CA trust
   *  injected, and the renderer gets per-block semantic events via
   *  `session:semantic-event`. Ignored for Codex and terminal
   *  sessions. */
  useProxy?: boolean
  /** Terminal + tmux only: when set AND tmux is available, attach to
   *  this existing tmux session instead of creating a new one. Used
   *  by the workspace reload path to recover persistent terminals
   *  (see Task 8 / tmuxRecovery). When the named session no longer
   *  exists, falls back to creating a fresh one. */
  recoverTmuxName?: string
}

// WHY private: same reasoning as SpawnOptions — the IPC handler that
// returns this to the renderer flattens it into a JSON payload at the
// boundary, so external code never sees the named type.
type SpawnResult = {
  sessionId: string
  /** Set only when a tmux-backed terminal was spawned (or recovered).
   *  Renderer must persist this so a subsequent launch can recover
   *  the same session via `recoverTmuxName`. */
  tmuxName?: string
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

// Narrow structural contract every agent session (claude, codex)
// must satisfy. Defined here (not imported from a provider) so the
// manager stays provider-agnostic: any future runtime we wire up
// through the provider registry has to expose exactly this surface.
//
// WHY we don't import the full ClaudeSession / CodexSession types:
//   - Importing concrete types couples the manager to every provider
//     and flips the dependency arrow — the manager is supposed to
//     orchestrate providers, not depend on their internals.
//   - The previous code cast `session` to `EventEmitter`, which
//     worked at runtime but left .write / .resize / .stop completely
//     unchecked. A provider that dropped one of those methods would
//     only fail in production. This interface closes that hole.
//
// The `on` method widens to EventEmitter's string-keyed signature on
// purpose: the manager subscribes to a fixed set of event names
// ('started', 'pty-data', 'screen', …) and each provider emits the
// same set, but encoding that set here would create a second source
// of truth next to ManagerEvents. The event shape is enforced by the
// assertions inside the forwarder callbacks.
interface AgentSessionLike {
  // Widen `listener` to `(...args: any[])` specifically so arrow
  // functions with narrow parameter types (e.g. `(snap: ScreenSnapshot)
  // => void`) remain assignable without casts at every call site.
  // A strict `(...args: unknown[]) => void` rejects those because
  // `unknown` is not narrowable to `ScreenSnapshot` — which is
  // technically correct but useless here, because the event shape
  // is the provider's responsibility, not the manager's.
  //
  // The loss: TypeScript won't verify the listener argument types
  // against the provider's actual emit payload. The trade: call-sites
  // stay readable and we don't leak `as unknown as ...` for every
  // `.on('screen', snap => ...)` in spawn(). Runtime correctness is
  // enforced by the provider registry contract above.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this
  write(data: string): void
  resize(cols: number, rows: number): void
  stop(): Promise<void>
  start(): Promise<void>
  getProcessPid?(): number | null
  isExited?(): boolean
  removeAllListeners?(event?: string): this
}

// Internal registry shape: we store the concrete instance plus its
// kind so kill/write/resize can dispatch without sniffing the object.
// The registry holds concrete session instances. Agent sessions
// (claude, codex) are created via the provider registry; terminal
// sessions are handled directly.
type RegistryEntry =
  | { kind: 'claude' | 'codex'; session: AgentSessionLike }
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
  private readonly lastActivityAt = new Map<string, number>()
  private readonly sessionSizes = new Map<string, PtySize>()

  // Optional tmux backing for terminal sessions. Constructed by the
  // app entrypoint AFTER detectAvailability() has resolved — we only
  // accept a registry that is known to be usable, so a non-null value
  // here means tmux IS installed. When null, terminal sessions fall
  // back to direct PTY spawn (no persistence).
  constructor(private readonly tmuxRegistry: TmuxRegistry | null = null) {
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
  // buffer per Claude/Codex session and expose it only when the debug
  // panel explicitly attaches.
  //
  // This deliberately uses the same attach/replay contract as
  // TerminalLeaf instead of forwarding every agent byte to the
  // renderer from process start: most users never open the raw inline
  // terminal, and agent PTYs can be noisy. Buffer in main, broadcast
  // only after an attach, and let the debug component replay the
  // buffer before draining live bytes.
  private readonly agentPtyBuffers = new Map<string, string>()
  private readonly agentPtyAttached = new Set<string>()
  private readonly agentPtyRestoreSizes = new Map<string, PtySize>()

  private markActivity(sessionId: string): void {
    this.lastActivityAt.set(sessionId, Date.now())
  }

  /**
   * Spawn a new session and return its sessionId. Blocks until the PTY
   * is spawned — after this resolves the caller can immediately start
   * sending input via `write()`.
   *
   * For Claude sessions, start() also attaches the JSONL watcher; for
   * terminal sessions it's just the PTY spawn.
   */
  async spawn(options: SpawnOptions): Promise<SpawnResult> {
    const kind: SessionKind = options.kind ?? 'claude'
    const sessionId = randomUUID()
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
    if (kind === 'claude' || kind === 'codex') {
      const initialSize = {
        cols: options.cols ?? 120,
        rows: options.rows ?? 40,
      }
      const provider = getMainProvider(kind)
      const createStartedAt = performance.now()
      // `session` here structurally conforms to AgentSessionLike —
      // every provider that registers through the registry is
      // contracted to expose start/stop/write/resize + the standard
      // 'started'/'pty-data'/'screen'/'jsonl-entry'/'jsonl-error'/
      // 'process-state'/'trust-dialog'/'resume-prompt'/
      // 'compaction-state'/'semantic-event'/'exit' events. We use
      // `as unknown as` so a provider-specific type that ALSO has
      // those methods (like ClaudeSession) passes the cast without
      // TS trying to verify structural equivalence on a wide
      // EventEmitter.on signature.
      const session = provider.createSession({
        cwd: options.cwd,
        binary: getToolPath(kind, kind),
        cols: initialSize.cols,
        rows: initialSize.rows,
        snapshotIntervalMs: 16,
        resumeSessionId: options.resumeSessionId,
        dangerousMode: options.dangerousMode,
        shellSessionId: sessionId,
        // Agent providers both accept `useProxy`. Claude uses the
        // mitmproxy path; Codex uses a local Responses proxy via
        // `openai_base_url`.
        useProxy: options.useProxy,
      }) as unknown as AgentSessionLike
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
      session.on('started', ({ projectDir }: { projectDir: string }) =>
        {
          this.markActivity(sessionId)
          this.emit('started', { sessionId, kind, projectDir })
        },
      )
      session.on('pty-data', (data: string) => {
        this.markActivity(sessionId)
        const prev = this.agentPtyBuffers.get(sessionId) ?? ''
        this.agentPtyBuffers.set(
          sessionId,
          appendCappedBuffer(prev, data, AGENT_PTY_BUFFER_CAP),
        )
        if (this.agentPtyAttached.has(sessionId)) {
          this.emit('agent-pty-data', { sessionId, data })
        }
        this.emit('pty-data', { sessionId, data })
      })
      session.on('screen', (snap: ScreenSnapshot) => {
        this.markActivity(sessionId)
        this.emit('screen', { sessionId, ...snap })
      })
      session.on('jsonl-entry', (entry: JsonlEntry, file: string) => {
        this.markActivity(sessionId)
        this.emit('jsonl-entry', { sessionId, entry, file })
      })
      session.on('jsonl-error', (error: Error) => {
        this.markActivity(sessionId)
        this.emit('jsonl-error', { sessionId, error })
      })
      session.on('process-state', (state: { active: boolean; status?: string }) =>
        {
          this.markActivity(sessionId)
          this.emit('process-state', { sessionId, ...state })
        },
      )
      session.on('trust-dialog', (state: { visible: boolean; workspace?: string }) =>
        this.emit('trust-dialog', { sessionId, ...state }),
      )
      session.on('resume-prompt', (state: {
        visible: boolean
        sessionAgeText?: string
        tokenCountText?: string
        options?: string[]
        selectedIndex?: number
      }) => this.emit('resume-prompt', { sessionId, ...state }))
      session.on('permission-prompt', (state: {
        visible: boolean
        title?: string
        toolName?: string
        command?: string
        options?: Array<{ key: string; label: string }>
        selectedIndex?: number
      }) => this.emit('permission-prompt', { sessionId, ...state }))
      session.on('compaction-state', (state: {
        visible: boolean
        phase?: 'running' | 'error' | 'done'
        statusText?: string
        errorText?: string
      }) => this.emit('compaction-state', { sessionId, ...state }))
      session.on('conditions', (snapshot: ProviderConditionSnapshot) => {
        this.markActivity(sessionId)
        this.emit('conditions', { sessionId, snapshot })
      })
      session.on('semantic-event', (event: unknown) => {
        this.markActivity(sessionId)
        this.emit('semantic-event', { sessionId, event })
      })
      session.on('exit', ({ exitCode, signal }: { exitCode: number; signal?: number }) => {
        this.markActivity(sessionId)
        this.emit('exit', { sessionId, exitCode, signal })
        this.sessions.delete(sessionId)
        this.agentPtyBuffers.delete(sessionId)
        this.agentPtyAttached.delete(sessionId)
        this.agentPtyRestoreSizes.delete(sessionId)
        this.sessionSizes.delete(sessionId)
        // Mirrors `kill()`: a session that exits naturally (provider
        // process died, user typed /exit, etc.) leaves a cursor entry
        // in `lastWrittenFeedDebugId` that would otherwise live until
        // the main process restarted. Cheap delete, idempotent if the
        // session never produced feed-debug entries.
        forgetFeedDebugSession(sessionId)
      })

      this.sessions.set(sessionId, { kind, session })
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
        this.sessions.delete(sessionId)
        this.agentPtyBuffers.delete(sessionId)
        this.agentPtyAttached.delete(sessionId)
        this.agentPtyRestoreSizes.delete(sessionId)
        this.sessionSizes.delete(sessionId)
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
      if (
        options.recoverTmuxName &&
        (await reg.sessionExists(options.recoverTmuxName))
      ) {
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
        data: { recovered: Boolean(options.recoverTmuxName && tmuxSessionName) },
      })
    }

    const initialSize = {
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
    }

    // WHY we thread the registry's binary through to TerminalSession:
    //   TerminalSession's tmux runtime spawns `tmux attach -t <name>`,
    //   so it needs to point at the SAME binary the registry just
    //   used to `new-session` the target. Once the bundled-only
    //   policy lands (see src/main/index.ts), PATH-resolved `tmux`
    //   could be a different version with an incompatible session
    //   format — using one tmux to create and another to attach
    //   would silently fail or worse, partially work. The registry
    //   is the source of truth.
    const session = new TerminalSession({
      cwd: options.cwd,
      cols: initialSize.cols,
      rows: initialSize.rows,
      runtime: useTmux ? 'tmux' : 'direct',
      tmuxSessionName: tmuxSessionName ?? undefined,
      tmuxBinary: useTmux ? this.tmuxRegistry?.getBinary() : undefined,
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
      this.emit('exit', { sessionId, exitCode, signal })
      this.sessions.delete(sessionId)
      this.terminalBuffers.delete(sessionId)
      this.terminalAttached.delete(sessionId)
      this.sessionSizes.delete(sessionId)
      // Same rationale as the agent-session exit path above: drop the
      // feed-debug cursor so it can't outlive the session it tracks.
      // Idempotent for terminal sessions that never produced feed-debug
      // entries.
      forgetFeedDebugSession(sessionId)
    })

    this.sessions.set(sessionId, { kind: 'terminal', session, tmuxName: tmuxSessionName })
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
      this.sessions.delete(sessionId)
      this.terminalBuffers.delete(sessionId)
      this.terminalAttached.delete(sessionId)
      this.sessionSizes.delete(sessionId)
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
   * terminal is a debug-only view into the underlying provider TUI.
   * Returning the buffered raw bytes lets the inline xterm reconstruct
   * the provider's latest terminal state, then `agent-pty-data`
   * carries subsequent live bytes for as long as the session remains
   * open.
   */
  attachAgentPty(sessionId: string): string {
    const entry = this.sessions.get(sessionId)
    if (!entry) return ''
    if (entry.kind !== 'claude' && entry.kind !== 'codex') {
      console.warn(
        `[SessionManager] attachAgentPty called on non-agent session`,
        { sessionId, kind: entry.kind },
      )
      return ''
    }
    const buffer = this.agentPtyBuffers.get(sessionId) ?? ''
    if (!this.agentPtyAttached.has(sessionId)) {
      const currentSize = this.sessionSizes.get(sessionId)
      if (currentSize) {
        this.agentPtyRestoreSizes.set(sessionId, { ...currentSize })
      }
    }
    this.agentPtyAttached.add(sessionId)
    return buffer
  }

  /**
   * Detach the debug inline terminal from a Claude/Codex session.
   * This disables raw PTY IPC forwarding and restores the provider PTY
   * size that was active before the inline terminal took ownership.
   */
  detachAgentPty(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    this.agentPtyAttached.delete(sessionId)
    const restoreSize = this.agentPtyRestoreSizes.get(sessionId)
    this.agentPtyRestoreSizes.delete(sessionId)
    if (!entry || (entry.kind !== 'claude' && entry.kind !== 'codex')) return
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
      return false
    }
    entry.session.write(data)
    return true
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
    const session = entry.session as unknown as {
      awaitPastePlaceholder?: (
        opts?: { timeoutMs?: number; pollIntervalMs?: number },
      ) => Promise<
        | { kind: 'appeared'; waitedMs: number }
        | { kind: 'timeout' }
        | { kind: 'no-headless' }
      >
    }
    if (typeof session.awaitPastePlaceholder !== 'function') {
      return { kind: 'no-session' }
    }
    return session.awaitPastePlaceholder(opts)
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
    this.sessions.delete(sessionId)
    if (entry.kind === 'claude' || entry.kind === 'codex') {
      this.agentPtyBuffers.delete(sessionId)
      this.agentPtyAttached.delete(sessionId)
      this.agentPtyRestoreSizes.delete(sessionId)
    }
    this.sessionSizes.delete(sessionId)
    // Drop feed-debug bookkeeping for this session. The on-disk JSONL
    // is left intact (a debug bundle saved later may still want it);
    // we only release the in-memory cursor that would otherwise live
    // forever in lastWrittenFeedDebugId. The write-queue Map self-
    // reaps in queueFeedDebugAppend when its chain settles.
    forgetFeedDebugSession(sessionId)
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
      const maybe = entry.session as {
        getProcessPid?: () => number | null
        isExited?: () => boolean
      }
      return {
        sessionId,
        kind: entry.kind,
        pid: maybe.getProcessPid?.() ?? null,
        exited: maybe.isExited?.() === true,
        lastActivityAt: this.lastActivityAt.get(sessionId) ?? null,
      }
    })
  }

  /** List all live session ids. Used for state save / debug. */
  list(): string[] {
    return Array.from(this.sessions.keys())
  }

  /** Kill every live session. Called on app quit. */
  async killAll(): Promise<void> {
    const ids = this.list()
    await Promise.all(ids.map(id => this.kill(id)))
  }
}
