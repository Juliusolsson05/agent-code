import { EventEmitter } from 'events'
import { join } from 'path'
import { spawn as ptySpawn } from 'node-pty'

import type { SlashPickerState } from '@preload/index.js'
import { PROXY_EVENTS_DIR } from '@main/storage/paths.js'
import {
  ClaudeCodeHeadless,
  createProxyServer,
  spawnClaudeWithProxy,
  type CompactionState,
  type ClaudeConditionSnapshot,
  type JsonlEntry,
  type PermissionPromptState,
  type ProxyServer,
  type ResumePromptState,
  type SemanticEvent,
  type TrustDialogState,
} from 'claude-code-headless'

// HISTORICAL: this file used to `export { terminalToMarkdown }` as a
// compat shim left over from when the function was inlined here before
// being moved into the headless package. The shim has zero callers in
// the repo today — consumers either import directly from
// claude-code-headless or from src/shared/runtime/ptyScreen — so the
// re-export is gone. If a future caller needs it, import it where it
// actually lives.

export type ClaudeSessionOptions = {
  cwd?: string
  cols?: number
  rows?: number
  binary?: string
  env?: Record<string, string | undefined>
  snapshotIntervalMs?: number
  resumeSessionId?: string
  dangerousMode?: boolean
  shellSessionId?: string
  /** Enable proxy-driven semantic streaming. When true, the session
   *  spawns a per-session mitmproxy runtime, launches Claude through
   *  it with CA trust injected, and feeds decrypted transport events
   *  into ClaudeCodeHeadless's proxy adapter. The renderer receives
   *  `semantic-event` messages in addition to the existing screen /
   *  jsonl / process-state signals.
   *
   *  When false (default), session behaves exactly as before: screen
   *  parsing is the semantic source and no mitmproxy process is
   *  spawned. This keeps the default user path zero-dependency on
   *  mitmproxy while letting opted-in users get the richer stream. */
  useProxy?: boolean
}

export type ScreenSnapshot = {
  plain: string
  markdown: string
  /** Wider window for the streaming extractor (see headless package
   *  HeadlessTerminal docstring for the why). */
  recent: string
  recentMarkdown: string
  picker: SlashPickerState
}

export type ClaudeSessionEvents = {
  started: [{ projectDir: string; proxyUrl?: string }]
  'pty-data': [string]
  screen: [ScreenSnapshot]
  'jsonl-entry': [JsonlEntry, string]
  'jsonl-error': [Error]
  // Optional status: the spinner verb ("Cogitating…", "Cascading…",
  // …) so the renderer can label its activity indicator with what CC
  // is actually doing rather than a generic "thinking…" placeholder.
  'process-state': [{ active: boolean; status?: string }]
  'trust-dialog': [TrustDialogState]
  'resume-prompt': [ResumePromptState]
  'permission-prompt': [PermissionPromptState]
  'compaction-state': [CompactionState]
  conditions: [ClaudeConditionSnapshot]
  /** New. The flat union of semantic-channel events (see
   *  claude-code-headless EVENT_SPEC.md). Forwarded verbatim so the
   *  renderer can treat it as the authoritative live-turn stream —
   *  block_started / text_delta / thinking_delta / tool_input_delta
   *  / tool_input_finalized / block_completed / turn_stopped /
   *  usage_updated / api_error / stream_error / flow_*.
   *
   *  Fires only when `options.useProxy` is true. When proxy is off,
   *  screen-driven `turn_delta` events fire instead (same channel,
   *  just sourced from the extractor) — consumers that subscribe to
   *  this event get the best available live signal either way. */
  'semantic-event': [SemanticEvent]
  exit: [{ exitCode: number; signal?: number }]
}

export interface ClaudeSession {
  on<K extends keyof ClaudeSessionEvents>(
    event: K,
    listener: (...args: ClaudeSessionEvents[K]) => void,
  ): this
  off<K extends keyof ClaudeSessionEvents>(
    event: K,
    listener: (...args: ClaudeSessionEvents[K]) => void,
  ): this
  emit<K extends keyof ClaudeSessionEvents>(
    event: K,
    ...args: ClaudeSessionEvents[K]
  ): boolean
}

export class ClaudeSession extends EventEmitter {
  private headless: ClaudeCodeHeadless | null = null
  private pty: ReturnType<typeof ptySpawn> | null = null
  private proxyServer: ProxyServer | null = null
  // Held so stop() can detach the listener explicitly. Letting the
  // proxy shutdown path drop the emitter isn't enough — the closure
  // captures `this.headless` and delays GC of the session object.
  private proxyEventHandler: ((ev: unknown) => void) | null = null
  private picker: SlashPickerState = { visible: false, items: [] }
  private exited = false
  /** Gate for the committed `tool_result` bridge. False until the
   *  JSONL tailer's initial replay has quiesced (250 ms without a new
   *  committed entry). Historical tool_results replayed during that
   *  window land on the committed channel — if we bridge them onto
   *  the semantic bus unconditionally, the renderer sees 8+ dead
   *  events before session_started fires (see 2026-04-20 evidence
   *  log id:1-8). Live tool_results for the ACTIVE turn still fire
   *  because a real streaming turn always has a longer gap between
   *  the committed entry and the prior bootstrap burst. */
  private readyForLiveBridge = false
  private liveBridgeTimer: NodeJS.Timeout | null = null

  private readonly cwd: string
  private readonly cols: number
  private readonly rows: number
  private readonly binary: string
  private readonly env: Record<string, string | undefined>
  private readonly snapshotIntervalMs: number
  private readonly resumeSessionId: string | null
  private readonly dangerousMode: boolean
  private readonly useProxy: boolean
  private readonly shellSessionId: string | null

  constructor(options: ClaudeSessionOptions = {}) {
    super()
    this.cwd = options.cwd ?? process.cwd()
    this.cols = options.cols ?? 120
    this.rows = options.rows ?? 40
    this.binary = options.binary ?? 'claude'
    this.resumeSessionId = options.resumeSessionId ?? null
    this.dangerousMode = options.dangerousMode === true
    this.snapshotIntervalMs = options.snapshotIntervalMs ?? 16
    this.useProxy = options.useProxy === true
    this.shellSessionId = options.shellSessionId ?? null

    const env: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') env[k] = v
    }
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop'
    for (const [k, v] of Object.entries(options.env ?? {})) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }
    this.env = env
  }

  async start(): Promise<void> {
    const args: string[] = []
    if (this.resumeSessionId) args.push('--resume', this.resumeSessionId)
    if (this.dangerousMode) args.push('--dangerously-skip-permissions')

    const cleanEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(this.env)) {
      if (typeof v === 'string') cleanEnv[k] = v
    }

    // Two spawn paths:
    //   useProxy=false → plain node-pty spawn, screen-driven semantics.
    //   useProxy=true  → start per-session mitmproxy, inject HTTPS_PROXY
    //                    + NODE_EXTRA_CA_CERTS via spawnClaudeWithProxy,
    //                    route transport events into the adapter.
    //
    // Resume args are preserved on the proxy branch by passing them
    // through node-pty's argv to spawnClaudeWithProxy. The helper
    // currently always spawns with empty argv, so we reach around it
    // when we need --resume or --dangerously-skip-permissions.
    if (this.useProxy) {
      // WHY proxy runtime storage must not live under `cwd`:
      //
      // Passing the workspace cwd into createProxyServer made the proxy layer
      // create timestamped runtime directories in whatever project the user had
      // open. That polluted repos with `proxy-events.jsonl`, mitmproxy CA
      // state, and other runtime artifacts. Agent Code owns the storage policy
      // and passes its concrete app-state root into the reusable package.
      const proxy = await createProxyServer({
        storageRoot: PROXY_EVENTS_DIR,
        confDir: join(PROXY_EVENTS_DIR, '_shared-conf'),
        cwd: this.cwd,
        sessionKey: this.resumeSessionId
          ? `resume-${this.resumeSessionId}`
          : (this.shellSessionId ? `shell-${this.shellSessionId}` : undefined),
      })
      await proxy.start()
      this.proxyServer = proxy

      if (args.length === 0) {
        // Fast path: no extra args, use the helper as-is.
        this.pty = spawnClaudeWithProxy({
          cwd: this.cwd,
          binary: this.binary,
          cols: this.cols,
          rows: this.rows,
          proxyUrl: proxy.info.proxyUrl,
          caCertPath: proxy.info.caCertPath,
        })
      } else {
        // Slower path: mirror spawnClaudeWithProxy's env setup but
        // pass our extra argv (--resume / --dangerously-skip-perms).
        // Kept inline rather than generalising the helper so the
        // helper's contract stays narrow and testable.
        const proxyEnv: Record<string, string> = { ...cleanEnv }
        proxyEnv.HTTPS_PROXY = proxy.info.proxyUrl
        proxyEnv.https_proxy = proxy.info.proxyUrl
        proxyEnv.HTTP_PROXY = proxy.info.proxyUrl
        proxyEnv.http_proxy = proxy.info.proxyUrl
        proxyEnv.NODE_EXTRA_CA_CERTS = proxy.info.caCertPath
        proxyEnv.SSL_CERT_FILE = proxy.info.caCertPath
        proxyEnv.REQUESTS_CA_BUNDLE = proxy.info.caCertPath
        proxyEnv.CURL_CA_BUNDLE = proxy.info.caCertPath
        proxyEnv.NO_PROXY = 'localhost,127.0.0.1,::1'
        proxyEnv.no_proxy = proxyEnv.NO_PROXY
        this.pty = ptySpawn(this.binary, args, {
          name: 'xterm-256color',
          cols: this.cols,
          rows: this.rows,
          cwd: this.cwd,
          env: proxyEnv,
        })
      }
    } else {
      this.pty = ptySpawn(this.binary, args, {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: this.cwd,
        env: cleanEnv,
      })
    }

    this.headless = new ClaudeCodeHeadless({
      pty: this.pty,
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      snapshotIntervalMs: this.snapshotIntervalMs,
      resumeSessionId: this.resumeSessionId ?? undefined,
      // Enabling proxy on the headless instance is what flips the
      // semantic source of truth from screen to proxy inside
      // ClaudeCodeHeadless. Even without this, subscribing to
      // semantic events would still yield screen-sourced deltas
      // (source='screen', confidence='fallback') — but consumers
      // that opted into proxy specifically want the richer stream.
      proxy: this.useProxy
        ? {
            // Sidecar Haiku filtering — see ClaudeProxyAdapter for
            // the full rationale, and docs/design/ghost-system.md
            // for how this interacts with the renderer-side shape
            // filter (rule 5 of the predicate). Without this, Claude
            // Code's auxiliary Haiku calls (session title generation,
            // compaction summaries, hook agents, teleport
            // title-and-branch) leak into the visible transcript as
            // orphan ghost entries because Claude Code never writes
            // them to the JSONL rollout, so the renderer's
            // ghost-supersede path can never fire.
            //
            // We default to assuming the user is on a non-Haiku
            // primary model. Why this is OK as a default:
            //
            //   * The vast majority of Agent Code users today run
            //     Sonnet/Opus; the Anthropic Max / Pro defaults land
            //     here.
            //   * The filter only fires when BOTH the flow's model
            //     matches `/haiku/i` AND the session model does NOT
            //     — so if the user IS on Haiku as primary, they need
            //     to opt out. The escape hatch is the
            //     `AGENT_CODE_PRIMARY_MODEL` env var below; setting it
            //     to a Haiku model id disables filtering.
            //   * The exact returned string doesn't matter as long as
            //     it doesn't match `/haiku/i`. The adapter only uses
            //     it for the pattern test, never as an authoritative
            //     model id.
            //
            // TODO(model-from-screen): replace this constant default
            // with parsing of Claude Code's header line ("Opus 4.7
            // (1M context) …") so we always know the actual primary
            // model and the env-var escape hatch becomes redundant.
            getSessionModel: () =>
              process.env.AGENT_CODE_PRIMARY_MODEL ??
              process.env.CC_SHELL_PRIMARY_MODEL ??
              'claude-opus-4-7',
          }
        : undefined,
    })

    // Pipe proxy transport events into the adapter. Only fires when
    // useProxy was set; `this.proxyServer` is otherwise null. We
    // subscribe AFTER constructing headless so the adapter exists
    // before any chunk arrives. The handler reference is held on
    // `this.proxyEventHandler` so stop() can detach it — otherwise
    // the EventEmitter keeps a reference to the closure (which closes
    // over `this.headless`) even after teardown, preventing GC of
    // the session object until the proxy process itself is collected.
    if (this.proxyServer) {
      this.proxyEventHandler = ev => {
        this.headless?.handleProxyTransportEvent(
          ev as Parameters<
            NonNullable<typeof this.headless>['handleProxyTransportEvent']
          >[0],
        )
      }
      this.proxyServer.on('event', this.proxyEventHandler)
    }

    this.pty.onData((data: string) => this.emit('pty-data', data))

    this.headless.on('slash-picker', picker => {
      this.picker = picker
    })

    this.headless.on('screen', snap => {
      this.emit('screen', {
        plain: snap.plain,
        markdown: snap.markdown,
        recent: snap.recent,
        recentMarkdown: snap.recentMarkdown,
        picker: this.headless?.getSlashPickerState() ?? this.picker,
      })
    })

    this.headless.on('jsonl-entry', (entry, file) =>
      this.emit('jsonl-entry', entry, file),
    )
    this.headless.on('jsonl-error', err =>
      this.emit('jsonl-error', err),
    )
    // Activity detection — derive process-state from the screen-based
    // spinner. CC's caffeinate-based ProcessInspector was stripped from
    // the headless package because caffeinate isn't reliably spawned
    // (fast turns skip it) and parent-shell caffeinates caused false
    // positives. Screen-spinner detection is the same signal Codex
    // uses; emitting process-state with the same shape keeps the
    // SessionManager / IPC / renderer wiring unchanged.
    this.headless.on('activity', status => {
      this.emit('process-state', { active: true, status })
    })
    this.headless.on('idle', () => {
      this.emit('process-state', { active: false })
    })
    this.headless.on('trust-dialog', state =>
      this.emit('trust-dialog', state),
    )
    this.headless.on('resume-prompt', state =>
      this.emit('resume-prompt', state),
    )
    this.headless.on('permission-prompt', state =>
      this.emit('permission-prompt', state),
    )
    this.headless.on('compaction-state', state =>
      this.emit('compaction-state', state),
    )
    this.headless.on('conditions', snapshot =>
      this.emit('conditions', snapshot),
    )
    this.headless.on('exit', ({ exitCode, signal }) => {
      this.exited = true
      this.emit('exit', { exitCode, signal })
    })

    // Semantic channel forwarder. We subscribe to the aggregated
    // 'event' emitter rather than each individual event name so the
    // session wrapper doesn't need to track the exact surface of the
    // semantic channel — any new event type we add upstream flows
    // through automatically.
    this.headless.semantic.on('event', (ev: SemanticEvent) => {
      this.emit('semantic-event', ev)
    })

    // Committed tool_result bridge.
    //
    // As of the 2026-04-18 headless redesign, tool_result events no
    // longer fire on `this.headless.semantic` — they land on
    // `this.headless.committed` instead, because a committed
    // transcript entry should not mutate the live semantic turn (see
    // the CommittedToolResultEvent docstring for full rationale).
    //
    // The RENDERER's reducer still consumes tool_result via the
    // existing `semantic-event` IPC path, keying on `toolUseId` to
    // pair results with their originating tool_use block. Migrating
    // the reducer to the committed channel is phase 6 work
    // (2026-04-18-headless-live-turn-redesign.md Task 13-14). For
    // phase 3 we keep the renderer contract identical by re-emitting
    // committed tool_result events over the semantic-event bus with
    // the shape the reducer expects.
    //
    // WHY re-emit instead of adding a second IPC channel now:
    //
    //   * Phase 3's goal is to stop mutating live semantic state at
    //     the HEADLESS boundary. Moving the publish off
    //     `this.headless.semantic` achieves that regardless of how we
    //     ship it to the renderer.
    //
    //   * A new IPC channel + renderer subscription is renderer
    //     cleanup, scheduled for phase 6. Doing it inline would bleed
    //     phases together and risk regressing the reducer's tool
    //     pairing mid-cleanup.
    //
    //   * The bridge is explicitly marked `source: 'jsonl'` /
    //     `confidence: 'high'` so debug tooling can still see "this
    //     came from a committed entry, not from a live SSE delta".
    this.headless.committed.on('tool_result', ev => {
      // Skip historical tool_results replayed during the initial
      // JSONL tail. The renderer already receives every committed
      // entry through `jsonl-entry` / `onSessionJsonlEntries`, which
      // stamps the tool_result content onto `runtime.toolResultIndex`
      // for Feed's tool_use → tool_result pairing. Bridging them onto
      // the semantic bus at bootstrap just makes 8+ dead events land
      // in foldSemanticEvent (all of which no-op because currentTurn
      // is null during replay) and pollutes the feed-debug SEM log.
      // After readyForLiveBridge flips, tool_results that arrive
      // during live turns flow through unchanged.
      if (!this.readyForLiveBridge) return
      // `ev.turnId` is the committed parent entry uuid, not the live
      // semantic turn id (`msg_…`). Forwarding it causes
      // foldSemanticEvent's strict turnId guard to drop the event before
      // the toolUseId match can run, leaving the live turn pinned and the
      // assistant text rendered twice. Omit it here and let the renderer
      // pair by toolUseId.
      const bridged: SemanticEvent = {
        type: 'tool_result',
        toolUseId: ev.toolUseId,
        content: ev.content,
        isError: ev.isError,
        source: 'jsonl',
        confidence: 'high',
        ts: ev.ts,
      }
      this.emit('semantic-event', bridged)
    })

    // Arm the live-bridge gate off committed entry landings. Every
    // committed entry (assistant commit, user commit, compact boundary)
    // resets a 250 ms quiet-window timer. When the timer fires without
    // another entry having landed, we know the initial tail replay
    // has quiesced and bridging can begin. Matches the renderer's
    // existing 150 ms bootstrap-debounce in workspaceStore — 250 ms
    // here gives a small margin so the first live turn's first
    // tool_result (which can arrive seconds after replay) isn't
    // delayed by bridge-priming.
    //
    // Fresh-session path: no committed entries arrive during tail
    // replay (the JSONL file doesn't exist yet), so the 'entry'
    // listener would never fire and readyForLiveBridge would stay
    // false forever. Kick off the same timer unconditionally at the
    // end of the constructor via `armLiveBridgeReady`, which serves
    // double duty as the initial arm and the re-arm on every entry.
    this.headless.committed.on('entry', () => {
      this.armLiveBridgeReady()
    })
    this.armLiveBridgeReady()

    const { projectDir } = await this.headless.start()
    this.emit('started', {
      projectDir,
      proxyUrl: this.proxyServer?.info.proxyUrl,
    })
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

  /**
   * Poll the live Claude TUI screen for `[Pasted text #N]` and resolve
   * the instant it appears. Delegates to ClaudeCodeHeadless; see the
   * method comment there for why this is load-independent and why a
   * timeout fallback is mandatory. Used by claudePaste.ts to send `\r`
   * exactly when Claude has visibly committed the paste — the
   * primary path of the paste-submit fix.
   *
   * Returns `{ kind: 'no-headless' }` when the headless instance has
   * not been constructed yet (start() not called or session torn down)
   * so the renderer can fall through to the wall-clock path without
   * waiting for the full 2 s timeout.
   */
  async awaitPastePlaceholder(
    opts?: { timeoutMs?: number; pollIntervalMs?: number },
  ): Promise<{ kind: 'appeared'; waitedMs: number } | { kind: 'timeout' } | { kind: 'no-headless' }> {
    if (!this.headless) return { kind: 'no-headless' }
    return this.headless.awaitPastePlaceholder(opts ?? {})
  }

  isExited(): boolean {
    return this.exited
  }

  getProcessPid(): number | null {
    return this.pty?.pid ?? null
  }

  /**
   * Reset the live-bridge quiet-window timer. Called once at the end
   * of the constructor (so fresh sessions that never replay anything
   * still arm) and once per committed.entry landing (so resume
   * sessions wait for tail replay to actually quiet down before
   * bridging tool_results). Idempotent after `readyForLiveBridge`
   * flips to true — the gate never goes back down.
   */
  private armLiveBridgeReady(): void {
    if (this.readyForLiveBridge) return
    if (this.liveBridgeTimer) clearTimeout(this.liveBridgeTimer)
    this.liveBridgeTimer = setTimeout(() => {
      this.liveBridgeTimer = null
      this.readyForLiveBridge = true
    }, 250)
  }

  async stop(): Promise<void> {
    if (this.liveBridgeTimer) {
      clearTimeout(this.liveBridgeTimer)
      this.liveBridgeTimer = null
    }
    await this.headless?.stop()
    try { this.pty?.kill() } catch { /* already gone */ }
    this.pty = null
    // Tear down the proxy runtime after the headless adapter has been
    // disposed. Order matters: `headless.stop()` calls
    // `adapter.dispose()` which frees per-flow state; stopping the
    // proxy first would leak chunk events into a live adapter during
    // the mitmdump shutdown window.
    if (this.proxyServer) {
      if (this.proxyEventHandler) {
        this.proxyServer.off('event', this.proxyEventHandler)
        this.proxyEventHandler = null
      }
      try {
        await this.proxyServer.stop()
      } catch (err) {
        // Best-effort shutdown, but not silent: if mitmdump hangs on
        // exit or the runtime dir can't be cleaned, a leaked proxy
        // process will keep the port bound and the next session spawn
        // will fail with an opaque bind error. Logging here is the
        // only breadcrumb that links that failure back to a prior
        // session's teardown.
        console.warn(
          `[claudeSession] proxy.stop() failed for session ${this.shellSessionId ?? '<unknown>'}:`,
          err,
        )
      }
      this.proxyServer = null
    }
  }
}
