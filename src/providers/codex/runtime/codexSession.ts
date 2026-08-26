import { EventEmitter } from 'events'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { spawn as ptySpawn } from 'node-pty'

import type { SlashPickerState } from '@preload/index.js'
import { PROXY_EVENTS_DIR } from '@main/storage/paths.js'
import { scheduleDebugStoragePrune } from '@main/storage/debugRetention.js'
import {
  CodexHeadless,
  CodexResponsesAdapter,
  ResponsesProxy,
  prepareCodex01491PromptInputProfile,
  prepareCodexResumeRollout,
} from 'codex-headless'
import type {
  CodexConditionSnapshot,
  CodexPromptInputProfile,
  CodexResumeRolloutPreparation,
  CodexRolloutDiagnostic,
  CodexRolloutLine,
  CodexSemanticEvent,
} from 'codex-headless'
import { canonicalizePath, sanitizePathSegment } from '@shared/runtime/projectDir.js'
import type { BuiltInMcpServerConfig } from '@mcp/shared/types.js'
import type {
  AgentInputReadiness,
  PromptGateState,
  PromptReadinessOutcome,
} from '@shared/types/session.js'
import { isCodexReadyForPromptScreen } from '@providers/codex/runtime/codexReadyForPrompt.js'
import { addCodexBuiltInMcpLaunchConfig } from '@providers/shared/runtime/builtInMcpLaunch.js'


/** Allocate a per-session run directory and return the path of its
 *  proxy-events.jsonl. Mirrors the layout claude-code-headless'
 *  ProxyServer / createWorkDir produces (see proxy/proxyServer.ts
 *  createWorkDir) so a single bundle-inspection tool can read either
 *  provider's proxy events without branching.
 *
 *  Path shape:
 *    ~/.config/agent-code/proxy/<project-segment>/<session-segment>/<timestamp>/proxy-events.jsonl
 *
 *  WHY a fresh run dir per call instead of reusing one per session:
 *    A single CodexSession can be stopped + restarted (binary crash,
 *    user resume after exit). Each restart spawns a new ResponsesProxy
 *    with its own listening port; reusing one events file would
 *    interleave events from multiple proxy lifetimes onto the same
 *    line stream, where consumers can't distinguish them. Fresh
 *    timestamped run dirs keep each proxy lifetime self-contained.
 *
 *  The directory is created here (not at file-open time inside the
 *  proxy) so a permission failure surfaces during session start rather
 *  than mid-flight on the first request. */
async function allocateProxyEventsFile(opts: {
  cwd: string
  sessionKey: string
}): Promise<string> {
  // Path layout MUST match the Claude proxy's createWorkDir
  // (packages/claude-code-headless/src/proxy/proxyServer.ts)
  // so a single bundle-inspection tool can read either provider's
  // proxy-events.jsonl with one path resolver. The sanitisation
  // strategy comes from the shared sanitizePath helper — Claude uses
  // the SAME helper inside the headless submodule, so using it here
  // guarantees both providers produce identical segments for
  // identical inputs. Diverging would silently make the reader miss
  // Codex bundles (or vice versa).
  const root = PROXY_EVENTS_DIR
  const canonicalCwd = await canonicalizePath(opts.cwd)
  const cwdSegment = sanitiseSegment(canonicalCwd) || 'unknown-project'
  const sessionSegment = sanitiseSegment(opts.sessionKey) || 'unknown-session'
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const runDir = join(root, cwdSegment, sessionSegment, ts)
  await mkdir(runDir, { recursive: true })
  scheduleDebugStoragePrune('codex-proxy-run-start')
  return join(runDir, 'proxy-events.jsonl')
}

/** Provider proxy-event path segment. The collapse/trim logic now lives in the
 *  shared `sanitizePathSegment` (one source of truth shared with the debug
 *  bundle reader; the Claude headless package keeps its own intentional
 *  mirror). We retain the `|| 'unknown'` fallback here to preserve the exact
 *  historical output for the (unreachable in practice) empty-input case. */
function sanitiseSegment(value: string): string {
  return sanitizePathSegment(value) || 'unknown'
}

// CodexSession — thin wrapper that spawns the `codex` binary in a PTY
// and delegates all screen parsing, transcript tailing, trust dialog
// detection, and activity tracking to the codex-headless package.
//
// This class owns the PTY lifecycle (spawn + kill). It passes the PTY
// to CodexHeadless which does all the headless terminal + parser work.
// Events are forwarded with sessionId-compatible shapes so
// SessionManager can treat Claude and Codex sessions uniformly.
//
// Why this wrapper exists at all (instead of using CodexHeadless directly):
//   - Agent Code needs to SPAWN the process (CodexHeadless takes an IPty)
//   - Agent Code needs the SlashPickerState shape for IPC compatibility
//   - The event shapes must match ClaudeSession's for SessionManager

export type CodexSessionOptions = {
  cwd?: string
  cols?: number
  rows?: number
  binary?: string
  env?: Record<string, string | undefined>
  snapshotIntervalMs?: number
  resumeSessionId?: string
  dangerousMode?: boolean
  shellSessionId?: string
  useProxy?: boolean
  builtInMcpServers?: BuiltInMcpServerConfig[]
}

export type CodexScreenSnapshot = {
  plain: string
  markdown: string
  /** Wider window for the streaming extractor — see HeadlessTerminal
   *  package docstring. Codex's TUI renders shorter assistant blocks
   *  than CC's, so the extractor here usually doesn't need it, but
   *  we forward for shape parity with ClaudeSession. */
  recent: string
  recentMarkdown: string
  picker: SlashPickerState
}

export type CodexSessionEvents = {
  started: [{ projectDir: string; proxyUrl?: string }]
  'input-readiness': [AgentInputReadiness]
  // Declared, never emitted. This provider latches a coarse ready boolean and
  // has no equivalent of Claude's detailed gate verdict, but the key must exist
  // for the session to satisfy AgentSession — the same interface-merging shape
  // the legacy Claude condition events use. A consumer simply never sees it
  // fire, which is the honest representation of "this provider cannot tell you
  // why it isn't ready".
  'prompt-gate': [PromptGateState]
  'pty-data': [string]
  screen: [CodexScreenSnapshot]
  'jsonl-entry': [CodexRolloutLine, string]
  'jsonl-error': [Error]
  'transcript-diagnostic': [CodexRolloutDiagnostic]
  // process-state carries the optional spinner-derived status string
  // (e.g. "working… 12s") so the renderer can show provider-specific
  // verbiage in its activity indicator. Without this, the renderer
  // falls back to Claude's detectActivity which doesn't recognize
  // Codex's bottom Working row and shows a generic "thinking…".
  'process-state': [{ active: boolean; status?: string }]
  'semantic-event': [CodexSemanticEvent]
  conditions: [CodexConditionSnapshot]
  // Trust dialog visibility — fires on EVERY transition (open + close).
  // Matches the shape Claude already emits so SessionManager's
  // provider-agnostic forwarder picks it up without changes.
  'trust-dialog': [{ visible: boolean; workspace?: string }]
  // Legacy per-condition Claude events (#394 phase 2a). Codex NEVER
  // emits these — they belong to the deprecated per-event surface
  // ClaudeSession still fires alongside the unified `conditions`
  // snapshot. Declared here anyway (with the same neutral payload
  // shape) so CodexSession's typed `on/emit` accepts the strictly-typed
  // AgentSessionEvents keys that sessionManager subscribes to. Without
  // this, `session.on('resume-prompt', …)` in the manager fails to
  // compile against Codex's narrower event map. Zero runtime cost —
  // no emit ever happens, so no listener ever fires. Phase 3 removes
  // the legacy channel entirely and this block goes with it.
  'resume-prompt': [import('@shared/types/session.js').AgentResumePromptState]
  'permission-prompt': [import('@shared/types/session.js').AgentPermissionPromptState]
  exit: [{ exitCode: number; signal?: number }]
}

export interface CodexSession {
  on<K extends keyof CodexSessionEvents>(
    event: K,
    listener: (...args: CodexSessionEvents[K]) => void,
  ): this
  off<K extends keyof CodexSessionEvents>(
    event: K,
    listener: (...args: CodexSessionEvents[K]) => void,
  ): this
  emit<K extends keyof CodexSessionEvents>(
    event: K,
    ...args: CodexSessionEvents[K]
  ): boolean
  awaitReadyForPrompt(
    opts?: { deadlineAt?: number; timeoutMs?: number; pollIntervalMs?: number },
  ): Promise<PromptReadinessOutcome>
}

type CodexStartAttempt = {
  generation: number
  cancelled: boolean
  proxyServer: ResponsesProxy | null
  proxyAdapter: CodexResponsesAdapter | null
  resumeRolloutPreparation: CodexResumeRolloutPreparation | null
  pty: ReturnType<typeof ptySpawn> | null
  headless: CodexHeadless | null
  rollbackPromise: Promise<void> | null
}

export class CodexSession extends EventEmitter {
  private headless: CodexHeadless | null = null
  private pty: ReturnType<typeof ptySpawn> | null = null
  private exited = false
  private composerReady = false

  private readonly cwd: string
  private readonly cols: number
  private readonly rows: number
  private readonly binary: string
  private readonly env: Record<string, string | undefined>
  private readonly snapshotIntervalMs: number
  private readonly resumeSessionId: string | null
  private readonly dangerousMode: boolean
  private readonly shellSessionId: string | null
  private readonly useProxy: boolean
  private readonly builtInMcpServers: BuiltInMcpServerConfig[]
  private proxyServer: ResponsesProxy | null = null
  private proxyAdapter: CodexResponsesAdapter | null = null
  private nextStartGeneration = 0
  private activeStartAttempt: CodexStartAttempt | null = null
  // Exists only across prepare -> PTY spawn -> event wiring. The parent keeps
  // rollback authority until the exact `headless.start()` call boundary; after
  // that call begins, the headless prepared-tail path owns lease retirement.
  private resumeRolloutPreparation: CodexResumeRolloutPreparation | null = null

  constructor(options: CodexSessionOptions = {}) {
    super()
    this.cwd = options.cwd ?? process.cwd()
    this.cols = options.cols ?? 120
    this.rows = options.rows ?? 40
    this.binary = options.binary ?? 'codex'
    this.resumeSessionId = options.resumeSessionId ?? null
    this.dangerousMode = options.dangerousMode === true
    this.shellSessionId = options.shellSessionId ?? null
    this.useProxy = options.useProxy === true
    this.builtInMcpServers = options.builtInMcpServers ?? []
    // Fallback matches sessionManager's explicit 100ms (~10Hz) — see
    // the WHY comment there (#390). Keeping this default in sync
    // matters because a `?? 16` here would silently restore the 60Hz
    // GC-storm cadence for any future caller that omits the option.
    this.snapshotIntervalMs = options.snapshotIntervalMs ?? 100

    // Build env: start from process.env so PATH, HOME, API keys
    // propagate. Force TERM + COLORTERM for proper color output.
    const env: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') env[k] = v
    }
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    for (const [k, v] of Object.entries(options.env ?? {})) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }
    this.env = env
  }

  async start(): Promise<void> {
    const previousAttempt = this.activeStartAttempt
    if (previousAttempt) previousAttempt.cancelled = true
    const attempt: CodexStartAttempt = {
      generation: ++this.nextStartGeneration,
      cancelled: false,
      proxyServer: null,
      proxyAdapter: null,
      resumeRolloutPreparation: null,
      pty: null,
      headless: null,
      rollbackPromise: null,
    }
    // WHY generation identity, rather than a permanent `stopped` boolean, is
    // the cancellation authority. CodexSession is restartable: stop may cancel
    // generation A while A is inside config/read, then generation B may begin
    // before A's promise resumes. Object identity lets A observe cancellation
    // without mistaking B's legitimate start for its own continuation.
    this.activeStartAttempt = attempt
    if (previousAttempt) {
      await this.rollbackStart(previousAttempt)
      if (!this.isStartAttemptActive(attempt)) return
    }
    this.exited = false
    this.composerReady = false
    this.emit('input-readiness', {
      ready: false,
      reason: this.resumeSessionId ? 'replaying-history' : 'provider-not-ready',
    })
    // Codex uses a subcommand for resume: `codex resume <id>`.
    const args: string[] = []
    // Filter undefined env entries before adding generated MCP credential variables. Keeping this
    // object local to one start prevents a stopped session's bearer from remaining on the reusable
    // session wrapper or leaking into another provider process.
    const cleanEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(this.env)) {
      if (typeof v === 'string') cleanEnv[k] = v
    }
    if (this.dangerousMode) {
      args.push('--dangerously-bypass-approvals-and-sandbox')
    }
    addCodexBuiltInMcpLaunchConfig(this.builtInMcpServers, args, cleanEnv)
    if (this.useProxy) {
      // Mirror the Claude proxy's on-disk layout so a single
      // bundle-inspection tool can read either provider's
      // proxy-events.jsonl without branching:
      //   ~/.config/agent-code/proxy/<project-segment>/<session-segment>/<timestamp>/proxy-events.jsonl
      //
      // The path discipline is identical to what
      // claude-code-headless' createProxyServer does (see ProxyServer
      // in proxy/proxyServer.ts createWorkDir). Codex's
      // ResponsesProxy doesn't own that allocation today (the
      // testing harness used to construct it without disk
      // persistence at all), so we compute it here and pass it as
      // an explicit `eventsFile` option.
      //
      // sessionKey naming mirrors Claude exactly: `resume-<id>` when
      // resuming a known thread, else `shell-<sessionId>` so a fresh
      // session still produces a stable folder name. Both segments
      // are sanitised before joining so a path-traversal attempt via
      // a malformed cwd or session id can't escape the proxy root.
      const eventsFile = await allocateProxyEventsFile({
        cwd: this.cwd,
        sessionKey: this.resumeSessionId
          ? `resume-${this.resumeSessionId}`
          // Fresh sessions do not have an upstream-stable provider id yet, but
          // the app-local pane id is stable for the lifetime of the process and
          // is the only identifier the renderer has when a user saves a bundle
          // before Codex writes session_meta. Match Claude's `shell-<id>`
          // convention so manual bundles can request exact fresh-session proxy
          // evidence instead of falling back to "latest run in this project".
          : (this.shellSessionId
              ? `shell-${this.shellSessionId}`
              : `shell-${new Date().toISOString().replace(/[:.]/g, '-')}`),
      })
      if (!this.isStartAttemptActive(attempt)) return
      const proxy = await ResponsesProxy.create({ eventsFile })
      if (!this.isStartAttemptActive(attempt)) {
        // WHY stop can win while create() is awaiting a listening socket. The
        // returned proxy did not exist when stop snapshotted the attempt, so the
        // continuation that receives it must close it locally and must never
        // publish it into fields now owned by a later generation.
        try { await proxy.stop() } catch { /* best-effort */ }
        return
      }
      attempt.proxyServer = proxy
      this.proxyServer = proxy
      args.push('--config', `openai_base_url=${JSON.stringify(proxy.info.proxyBaseUrl)}`)
    }
    // From here on we have a listening proxy (if useProxy was set) but
    // no PTY, no CodexHeadless, and therefore no exit/stop plumbing.
    // Any throw between the proxy-create above and the end of start()
    // leaks the proxy HTTP server — nothing else would ever call
    // stop() on it. Wrap everything in a try/catch that rolls back.
    let promptInputProfile: CodexPromptInputProfile | null = null
    try {
      if (this.resumeSessionId) {
        // WHY this must precede ptySpawn: Codex can reconstruct a resume fork
        // immediately after process creation. Locating X and registering its
        // lineage afterwards leaves a real interval where a same-cwd fresh
        // sibling can lease Y. The capability makes the ordering auditable and
        // gives rollback one object that owns every pre-spawn reservation.
        const preparation = await prepareCodexResumeRollout({
          cwd: this.cwd,
          resumeThreadId: this.resumeSessionId,
          onError: error => this.emit('jsonl-error', error),
        })
        if (!this.isStartAttemptActive(attempt)) {
          // WHY this capability may materialize after stop already found the
          // attempt empty. The awaiting start continuation is then its sole
          // owner and must dispose it directly; a shared-field rollback cannot
          // see it and would leak exact-path/lineage authority.
          try { await preparation.dispose(true) } catch { /* best-effort */ }
          return
        }
        attempt.resumeRolloutPreparation = preparation
        this.resumeRolloutPreparation = preparation
      }
      // WHY config/read must be the final awaited operation before ptySpawn.
      // Resume preparation recursively locates and reads exact X; running it
      // after attestation left a material interval where managed keymap policy
      // could change while the stale profile still authorized Enter/Tab prompt
      // evidence. All ownership preparation now completes first. From this
      // point through spawn there is no application await.
      promptInputProfile = await this.preparePromptInputProfile(args, cleanEnv)
      if (!this.isStartAttemptActive(attempt)) return
      if (promptInputProfile) {
        // These immutable overrides were resolved by the same binary/cwd/env
        // and exact base prefix. Keep them as the last global configuration
        // arguments immediately before the selected TUI subcommand.
        args.push(...promptInputProfile.cliArgs)
      }
      if (this.resumeSessionId) {
        args.push('resume', this.resumeSessionId)
      }
      // WHY keep a distinct check at the synchronous boundary even though the
      // config/read check is immediately above. Config/read must remain the final
      // await before spawn, while this line documents and enforces the stronger
      // invariant: only the still-current generation may enter ptySpawn at all.
      if (!this.isStartAttemptActive(attempt)) return
      // Spawn the PTY.
      const pty = ptySpawn(this.binary, args, {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: this.cwd,
        env: cleanEnv,
      })
      attempt.pty = pty
      this.pty = pty
    } catch (err) {
      await this.rollbackStart(attempt)
      throw err
    }

    // Create CodexHeadless — it attaches to the PTY and does all
    // the headless terminal + parser + transcript work.
    try {
      const common = {
        pty: this.pty,
        cwd: this.cwd,
        cols: this.cols,
        rows: this.rows,
        snapshotIntervalMs: this.snapshotIntervalMs,
        promptInputProfile: promptInputProfile ?? undefined,
      }
      if (this.resumeSessionId) {
        const preparation = this.resumeRolloutPreparation
        if (!preparation) {
          throw new Error('Codex resume ownership was not prepared before spawn')
        }
        const headless = new CodexHeadless({
          ...common,
          resumeThreadId: this.resumeSessionId,
          resumeRolloutPreparation: preparation,
        })
        attempt.headless = headless
        this.headless = headless
      } else {
        const headless = new CodexHeadless(common)
        attempt.headless = headless
        this.headless = headless
      }
    } catch (err) {
      await this.rollbackStart(attempt)
      throw err
    }

    let sessionsDir: string
    try {
      // Forward raw PTY bytes — SessionManager expects this event.
      this.pty.onData((data: string) => {
        this.emit('pty-data', data)
      })

      // Forward screen snapshots.
      this.headless.on('screen', snap => {
        this.markComposerReady(snap.plain)
        this.emit('screen', {
          plain: snap.plain,
          markdown: snap.markdown,
          recent: snap.recent,
          recentMarkdown: snap.recentMarkdown,
          // Codex doesn't have a slash picker yet — static "not visible"
          // so the renderer's picker component stays hidden.
          picker: { visible: false, items: [] },
        })
      })

      // Forward the activity status string (the bottom Working row text
      // parsed by codex-headless). Without `status`, the renderer's
      // ActivityIndicator falls back to detectActivity on the screen
      // plaintext, which is a Claude-specific spinner detector and
      // returns null for Codex panes — leaving them with the generic
      // "thinking…" placeholder despite the working state being known.
      this.headless.on('activity', status => {
        this.emit('process-state', { active: true, status })
      })

      this.headless.on('idle', () => {
        this.emit('process-state', { active: false })
      })

      // Forward trust dialog state. The headless emits on every
      // transition (visible + hidden) so the renderer can mount and
      // unmount the modal in lockstep with Codex's own dialog.
      this.headless.on('trust-dialog', state => {
        this.emit('trust-dialog', state)
      })

      this.headless.on('conditions', snapshot => {
        this.emit('conditions', snapshot)
      })

      // Forward rollout entries as jsonl-entry (matches Claude's event name).
      this.headless.on('rollout-entry', (line, file) => {
        this.emit('jsonl-entry', line, file)
      })

      this.headless.on('rollout-error', err => {
        this.emit('jsonl-error', err)
      })

      // WHY this is a diagnostic channel instead of jsonl-error: a held fresh
      // candidate is the safe fail-closed outcome when ownership is not proven.
      // Calling it an error makes a healthy sibling rollout look fatal; dropping
      // it made #632 indistinguishable from failed PTY delivery. The main process
      // records this content-safe evidence but no renderer correctness path uses
      // it.
      this.headless.on('rollout-diagnostic', diagnostic => {
        this.emit('transcript-diagnostic', diagnostic)
      })

      this.headless.semantic.on('event', (ev: CodexSemanticEvent) => {
        this.emit('semantic-event', ev)
      })

      if (this.proxyServer) {
        // The adapter parses OpenAI Responses SSE and publishes to the
        // same SemanticChannel the rollout reducer writes to. When both
        // sources overlap, the channel emits `source_changed` so the
        // renderer can see which source is driving the live text. The
        // proxy wins the first-chunk race; rollout later reconciles
        // with the authoritative text at task_complete.
        const proxyAdapter = new CodexResponsesAdapter(
          this.proxyServer,
          this.headless,
        )
        attempt.proxyAdapter = proxyAdapter
        this.proxyAdapter = proxyAdapter
        proxyAdapter.attach()
      }

      this.headless.on('exit', ({ exitCode, signal }) => {
        this.exited = true
        this.composerReady = false
        this.emit('input-readiness', { ready: false, reason: 'provider-not-ready' })
        this.emit('exit', { exitCode, signal })
      })

      // Start the transcript tailer BEFORE we emit started — same ordering as
      // ClaudeSession to avoid missing early entries. Ownership crosses from
      // the parent to CodexHeadless at this exact call boundary: every setup
      // throw above still leaves rollbackStart a preparation to dispose, while
      // every throw inside start is cleaned by the prepared tail path itself.
      // Clearing the alias before awaiting also prevents both layers from
      // independently deciding the physical tail's close outcome.
      const preparedOwnership = attempt.resumeRolloutPreparation
      attempt.resumeRolloutPreparation = null
      if (preparedOwnership &&
        this.resumeRolloutPreparation === preparedOwnership) {
        this.resumeRolloutPreparation = null
      }
      const res = await this.headless.start()
      if (!this.isStartAttemptActive(attempt)) return
      sessionsDir = res.sessionsDir
    } catch (err) {
      await this.rollbackStart(attempt)
      throw err
    }

    // Codex activity is derived from its explicit bottom working row,
    // parsed in codex-headless and forwarded here as process-state for
    // app-level compatibility.

    this.emit('started', {
      projectDir: sessionsDir,
      proxyUrl: this.proxyServer?.info.proxyBaseUrl,
    })
  }

  private async preparePromptInputProfile(
    baseArgs: readonly string[],
    env: Readonly<Record<string, string>>,
  ): Promise<CodexPromptInputProfile | null> {
    const preparation = await prepareCodex01491PromptInputProfile({
      binary: this.binary,
      cwd: this.cwd,
      env,
      baseArgs,
    })
    if (preparation.ok) return preparation.profile

    // WHY profile refusal must not make the terminal unusable. Custom/new
    // binaries and user policy still launch with their untouched keymap; only
    // fresh-rollout prompt ownership is disabled, because a plausible but
    // unverified prompt is more dangerous than a missing transcript edge.
    this.emit(
      'jsonl-error',
      new Error(
        `Codex prompt evidence disabled: ${preparation.reason}`,
      ),
    )
    return null
  }

  // Unified cleanup for start() failure paths. Must be safe to call
  // regardless of how far start() got — each field is guarded with
  // optional chaining and try/catch so a failure mid-construction
  // (e.g. proxy up, PTY up, headless half-attached) doesn't cascade
  // into a second throw that masks the original error.
  private isStartAttemptActive(attempt: CodexStartAttempt): boolean {
    return !attempt.cancelled && this.activeStartAttempt === attempt
  }

  private async rollbackStart(attempt?: CodexStartAttempt): Promise<void> {
    // Direct lifecycle tests and defensive callers can still invoke rollback on
    // manually installed fields. Production always supplies its generation so
    // cleanup cannot mistake a later start's objects for the cancelled one's.
    const owned: CodexStartAttempt = attempt ?? {
      generation: 0,
      cancelled: true,
      proxyServer: this.proxyServer,
      proxyAdapter: this.proxyAdapter,
      resumeRolloutPreparation: this.resumeRolloutPreparation,
      pty: this.pty,
      headless: this.headless,
      rollbackPromise: null,
    }
    owned.cancelled = true
    if (this.activeStartAttempt === owned) this.activeStartAttempt = null
    if (owned.rollbackPromise) {
      await owned.rollbackPromise
      return
    }

    const proxyAdapter = owned.proxyAdapter
    const proxyServer = owned.proxyServer
    const headless = owned.headless
    const preparation = owned.resumeRolloutPreparation
    const pty = owned.pty
    owned.proxyAdapter = null
    owned.proxyServer = null
    owned.headless = null
    owned.resumeRolloutPreparation = null
    owned.pty = null

    // WHY clear shared aliases only by object identity. Generation A may resume
    // from an old await after generation B has already published its own proxy,
    // capability, PTY, or headless. Unconditional null assignments are a
    // delayed cross-generation teardown even if every individual stop is
    // otherwise idempotent.
    if (proxyAdapter && this.proxyAdapter === proxyAdapter) this.proxyAdapter = null
    if (proxyServer && this.proxyServer === proxyServer) this.proxyServer = null
    if (headless && this.headless === headless) this.headless = null
    if (preparation && this.resumeRolloutPreparation === preparation) {
      this.resumeRolloutPreparation = null
    }
    if (pty && this.pty === pty) this.pty = null

    owned.rollbackPromise = (async () => {
      try { proxyAdapter?.detach() } catch { /* best-effort */ }
      // WHY begin pre-spawn capability disposal before any cleanup await. A
      // proxy can take time to drain sockets, but exact-path/lineage authority
      // must be revoked as soon as stop closes launch admission. Starting the
      // promise here preserves adapter -> proxy -> headless teardown for running
      // sessions (their preparation has already transferred and is null) while
      // preventing a blocked proxy stop from extending pre-spawn ownership.
      const preparationDisposal = (async () => {
        try { await preparation?.dispose(true) } catch { /* best-effort */ }
      })()
      try { await proxyServer?.stop() } catch { /* best-effort */ }
      // WHY a partially started headless must stop before its PTY is discarded:
      // codex-headless registers path leases in a shared process-wide graph.
      // Skipping its transactional stop leaks live membership; killing the PTY
      // first admits final provider flushes while ownership is still callback-live.
      try { await headless?.stop() } catch { /* best-effort */ }
      await preparationDisposal
      try { pty?.kill() } catch { /* best-effort */ }
    })()
    await owned.rollbackPromise
  }

  write(data: string): void {
    this.headless?.write(data)
  }

  async awaitReadyForPrompt(
    opts?: { deadlineAt?: number; timeoutMs?: number; pollIntervalMs?: number },
  ): Promise<PromptReadinessOutcome> {
    const pollIntervalMs = opts?.pollIntervalMs ?? 50
    const startedAt = Date.now()
    const deadlineAt = opts?.deadlineAt ?? startedAt + (opts?.timeoutMs ?? 10_000)
    if (!this.headless) return { kind: 'terminal', reason: 'no-headless' }
    if (this.exited) return { kind: 'terminal', reason: 'exited' }

    return await new Promise(resolve => {
      const tick = (): void => {
        if (this.exited) {
          resolve({ kind: 'terminal', reason: 'exited' })
          return
        }
        if (!this.headless) {
          resolve({ kind: 'terminal', reason: 'no-headless' })
          return
        }
        // The trust dialog is checked BEFORE the screen, and this ordering is
        // the whole point of the check.
        //
        // Codex readiness used to be screen-only, and a trust dialog hides the
        // composer by design — so "a human must answer a modal" looked exactly
        // like "the composer has not painted yet". That resolved as `timeout`,
        // whose disposition is 'retry-same-session', so the caller retried at
        // once and each attempt held the prompt-delivery reservation for a
        // further 15 seconds. sessionManager.write() drops every external write
        // while that reservation is held, so the user's clicks on the trust
        // modal never reached the PTY and the app had to be restarted to
        // recover. Claude never had this failure because its gate consults
        // conditions first and reports 'blocked'.
        //
        // Two things change, and it is worth being precise about which does
        // the work. Mechanically: the poll now resolves on the FIRST tick
        // instead of running the 15s deadline, so the reservation is held for
        // under a millisecond and the modal's keystrokes land. Semantically:
        // 'blocked' carries disposition 'retry-after-resolve' rather than
        // 'retry-same-session', so a caller is told a HUMAN must act. Note the
        // retry loop was never in-process — no caller of deliverPromptToAgent
        // retries; the loop is an orchestrating model reacting to the
        // disposition text. The reservation window is the mechanical fix.
        const condition = this.blockingCondition()
        if (condition) {
          resolve({
            kind: 'blocked',
            condition: condition.kind,
            resolvable: condition.resolvable,
          })
          return
        }

        const screen = this.headless?.getScreen() ?? ''
        if (isCodexReadyForPromptScreen(screen)) {
          this.markComposerReady(screen)
          resolve({ kind: 'ready', waitedMs: Date.now() - startedAt })
          return
        }
        if (Date.now() >= deadlineAt) {
          resolve({
            kind: 'timeout',
            waitedMs: Date.now() - startedAt,
            lastState: { kind: 'warming', reason: 'composer-unpainted' },
          })
          return
        }
        setTimeout(tick, pollIntervalMs)
      }
      tick()
    })
  }

  /**
   * The blocking, human-answerable condition currently on screen, or null.
   *
   * WHY this is a curated list rather than "any condition". An earlier cut
   * returned the first entry in the snapshot, which is unsafe for two reasons:
   *
   *   1. Not every condition is a modal a human answers. `codex.approval` can
   *      linger as STALE state: `approvalMetadata` is set on
   *      exec_approval_request and cleared at exactly one site — the
   *      exec_command_end handler (CodexHeadless.ts). Deny an approval and no
   *      command ever runs, so nothing clears it, and `mergeApprovalState`
   *      keeps the record live on metadata alone. Blocking on that would have
   *      made every later prompt to an otherwise healthy session fail forever,
   *      with nothing for a human to resolve — a worse and far more routine
   *      failure than the trust-dialog deadlock this fixes.
   *   2. `resolvable` (actions.length > 0) does NOT filter that out, because a
   *      stale approval still advertises approve/deny actions.
   *
   * The precise invariant that makes an entry safe to block on is NOT "level
   * triggered" — the snapshot is a cached field republished from a 100ms
   * throttled, change-gated screen flush, so it is edge-triggered. It is that
   * the state is NEVER LATCHED and dismissing the modal necessarily produces a
   * changed frame, so it clears within one flush. State that requires a
   * specific clearing event (approvalMetadata) can outlive the modal; state
   * overwritten on every frame cannot. Widen this list only for entries that
   * meet that bar.
   *
   * Both blocking screens matter: they are the two that can hold a session
   * before its composer paints, which is what turns them into deadlocks rather
   * than delays. Note codexReadyForPrompt recognizes four more not-ready
   * screens ('Working (', 'Allow command', "don't ask again"); those are
   * transient or lack a condition record, so they still fall through to the
   * screen poll deliberately.
   */
  private blockingCondition(): { kind: string; resolvable: boolean } | null {
    const conditions = this.headless?.getConditionSnapshot()?.conditions
    if (!conditions) return null

    const trust = conditions['codex.trust-dialog']
    if (trust) return { kind: trust.kind, resolvable: trust.actions.length > 0 }

    // Approvals are included ONLY when the modal is provably on screen.
    // `mergeApprovalState` merges two sources and just one of them is sticky:
    // the screen half (`detectCodexApproval`) is overwritten every frame like
    // the trust dialog, while `approvalMetadata` is rollout-sourced and clears
    // at a single site. `options` is the discriminant — the metadata-only
    // branch synthesizes `options: []`, so a non-empty options array proves the
    // user is looking at the modal right now rather than at leftover state from
    // an approval they denied. Blocking on the sticky half would strand healthy
    // sessions forever with nothing to resolve.
    const approval = conditions['codex.approval']
    if (approval && approval.state.options.length > 0) {
      return { kind: approval.kind, resolvable: approval.actions.length > 0 }
    }
    return null
  }

  private markComposerReady(screen: string): void {
    if (this.composerReady || this.exited || !isCodexReadyForPromptScreen(screen)) return
    // WHY this latches instead of mirroring every screen: the composer
    // intentionally disappears while Codex is working. Once startup/trust
    // chrome has yielded a real composer, ordinary turns must not flap the
    // renderer disabled. Exit is the only boundary that clears the latch.
    this.composerReady = true
    this.emit('input-readiness', { ready: true, reason: 'ready' })
  }

  resize(cols: number, rows: number): void {
    this.headless?.resize(cols, rows)
  }

  snapshotScreen(): string {
    return this.headless?.getScreen() ?? ''
  }

  snapshotScreenAsMarkdown(): string {
    return this.headless?.getScreenMarkdown() ?? ''
  }

  isExited(): boolean {
    return this.exited
  }

  getProcessPid(): number | null {
    return this.pty?.pid ?? null
  }

  async stop(): Promise<void> {
    const attempt = this.activeStartAttempt
    if (attempt) {
      // WHY cancellation becomes visible before the first cleanup await. A safe
      // config/read or proxy create may complete while stop is draining another
      // resource; its continuation must already see admission closed and return
      // without spawning. Clearing only at the end recreates the late-provider
      // resurrection recorded by the eleventh gate.
      attempt.cancelled = true
      if (this.activeStartAttempt === attempt) this.activeStartAttempt = null
      await this.rollbackStart(attempt)
      return
    }

    // Defensive legacy path for manually installed/direct-test resources. The
    // same identity-scoped rollback preserves the adapter -> proxy -> headless ->
    // preparation -> PTY order and remains idempotent across repeated stop calls.
    await this.rollbackStart()
  }
}
