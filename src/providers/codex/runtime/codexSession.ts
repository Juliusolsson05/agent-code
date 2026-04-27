import { EventEmitter } from 'events'
import { spawn as ptySpawn } from 'node-pty'

import type { SlashPickerState } from '@preload/index.js'
import {
  CodexHeadless,
  CodexResponsesAdapter,
  ResponsesProxy,
  type CodexConditionSnapshot,
  type CodexRolloutLine,
  type CodexSemanticEvent,
} from 'codex-headless'

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
//   - cc-shell needs to SPAWN the process (CodexHeadless takes an IPty)
//   - cc-shell needs the SlashPickerState shape for IPC compatibility
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
  useProxy?: boolean
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
  'pty-data': [string]
  screen: [CodexScreenSnapshot]
  'jsonl-entry': [CodexRolloutLine, string]
  'jsonl-error': [Error]
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
}

export class CodexSession extends EventEmitter {
  private headless: CodexHeadless | null = null
  private pty: ReturnType<typeof ptySpawn> | null = null
  private exited = false

  private readonly cwd: string
  private readonly cols: number
  private readonly rows: number
  private readonly binary: string
  private readonly env: Record<string, string | undefined>
  private readonly snapshotIntervalMs: number
  private readonly resumeSessionId: string | null
  private readonly dangerousMode: boolean
  private readonly useProxy: boolean
  private proxyServer: ResponsesProxy | null = null
  private proxyAdapter: CodexResponsesAdapter | null = null

  constructor(options: CodexSessionOptions = {}) {
    super()
    this.cwd = options.cwd ?? process.cwd()
    this.cols = options.cols ?? 120
    this.rows = options.rows ?? 40
    this.binary = options.binary ?? 'codex'
    this.resumeSessionId = options.resumeSessionId ?? null
    this.dangerousMode = options.dangerousMode === true
    this.useProxy = options.useProxy === true
    this.snapshotIntervalMs = options.snapshotIntervalMs ?? 16

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
    // Codex uses a subcommand for resume: `codex resume <id>`.
    const args: string[] = []
    if (this.dangerousMode) {
      args.push('--dangerously-bypass-approvals-and-sandbox')
    }
    if (this.resumeSessionId) {
      args.push('resume', this.resumeSessionId)
    }
    if (this.useProxy) {
      const proxy = await ResponsesProxy.create()
      this.proxyServer = proxy
      args.push('--config', `openai_base_url=${JSON.stringify(proxy.info.proxyBaseUrl)}`)
    }

    // Filter undefined env entries — node-pty expects strings only.
    const cleanEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(this.env)) {
      if (typeof v === 'string') cleanEnv[k] = v
    }

    // From here on we have a listening proxy (if useProxy was set) but
    // no PTY, no CodexHeadless, and therefore no exit/stop plumbing.
    // Any throw between the proxy-create above and the end of start()
    // leaks the proxy HTTP server — nothing else would ever call
    // stop() on it. Wrap everything in a try/catch that rolls back.
    try {
      // Spawn the PTY.
      this.pty = ptySpawn(this.binary, args, {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: this.cwd,
        env: cleanEnv,
      })
    } catch (err) {
      await this.rollbackStart()
      throw err
    }

    // Create CodexHeadless — it attaches to the PTY and does all
    // the headless terminal + parser + transcript work.
    this.headless = new CodexHeadless({
      pty: this.pty,
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      snapshotIntervalMs: this.snapshotIntervalMs,
      resumeThreadId: this.resumeSessionId ?? undefined,
    })

    // Forward raw PTY bytes — SessionManager expects this event.
    this.pty.onData((data: string) => {
      this.emit('pty-data', data)
    })

    // Forward screen snapshots.
    this.headless.on('screen', snap => {
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
      this.emit('jsonl-entry', line as unknown as CodexRolloutLine, file)
    })

    this.headless.on('rollout-error', err => {
      this.emit('jsonl-error', err)
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
      this.proxyAdapter = new CodexResponsesAdapter(this.proxyServer, this.headless)
      this.proxyAdapter.attach()
    }

    this.headless.on('exit', ({ exitCode, signal }) => {
      this.exited = true
      this.emit('exit', { exitCode, signal })
    })

    // Start the transcript tailer BEFORE we emit started — same
    // ordering as ClaudeSession to avoid missing early entries.
    //
    // If headless.start() throws we're in the same leak shape as a
    // pty-spawn failure: a listening proxy server, a live PTY, and
    // a partially-constructed CodexHeadless. Roll back all three so
    // the caller can retry cleanly instead of being told "start
    // failed" while a port quietly stays bound.
    let sessionsDir: string
    try {
      const res = await this.headless.start()
      sessionsDir = res.sessionsDir
    } catch (err) {
      await this.rollbackStart()
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

  // Unified cleanup for start() failure paths. Must be safe to call
  // regardless of how far start() got — each field is guarded with
  // optional chaining and try/catch so a failure mid-construction
  // (e.g. proxy up, PTY up, headless half-attached) doesn't cascade
  // into a second throw that masks the original error.
  private async rollbackStart(): Promise<void> {
    try { this.proxyAdapter?.detach() } catch { /* best-effort */ }
    this.proxyAdapter = null
    try { await this.proxyServer?.stop() } catch { /* best-effort */ }
    this.proxyServer = null
    try { this.pty?.kill() } catch { /* best-effort */ }
    this.pty = null
    // Intentionally no headless teardown here: if headless.start()
    // threw, its internal state is undefined; calling stop() on it
    // risks a second throw. Let GC collect it.
    this.headless = null
  }

  write(data: string): void {
    this.headless?.write(data)
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
    // Teardown order matters. The adapter is a listener on the proxy
    // that writes into `this.headless.semantic`. If we stop() the
    // headless first while the proxy is still listening, any trailing
    // SSE chunk the upstream has already flushed will fire the
    // listener and mutate a post-stop headless — observable as
    // "semantic events keep arriving after stop()" in debug logs.
    //
    // Correct order:
    //   1. Detach the adapter so no new mutations reach headless.
    //   2. Stop the proxy so upstream sockets are torn down (see
    //      ResponsesProxy.stop() — it force-destroys sockets so we
    //      don't wait for a long-running SSE turn).
    //   3. Stop headless, which tears down its transcript tailer
    //      and semantic reducer cleanly.
    //   4. Kill the PTY last; headless.stop() may still want to
    //      drain final output from the terminal stream.
    try { this.proxyAdapter?.detach() } catch { /* best-effort */ }
    this.proxyAdapter = null
    try {
      await this.proxyServer?.stop()
    } catch (err) {
      console.warn(
        `[codexSession] proxy.stop() failed:`,
        err,
      )
    }
    this.proxyServer = null
    try { await this.headless?.stop() } catch (err) {
      console.warn(`[codexSession] headless.stop() failed:`, err)
    }
    try { this.pty?.kill() } catch { /* already gone */ }
    this.pty = null
  }
}
