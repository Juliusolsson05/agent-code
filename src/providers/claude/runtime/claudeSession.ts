import { EventEmitter } from 'events'
import { join } from 'path'
import { spawn as ptySpawn } from 'node-pty'

import type { SlashPickerState } from '@preload/index.js'
import { PROXY_EVENTS_DIR } from '@main/storage/paths.js'
import { resolveBundledTool } from '@main/setup/runtimeTools.js'
import { getToolPath } from '@main/setup/toolchain.js'
import type { BuiltInMcpServerConfig } from '@mcp/shared/types.js'
import {
  ClaudeCodeHeadless,
  createProxyServer,
  type ClaudeConditionSnapshot,
  type ConditionCustomAction,
  type CompactionState,
  type DriveResult,
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
  builtInMcpServers?: BuiltInMcpServerConfig[]
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
  /** Unified conditions snapshot (PR-3). Forwarded verbatim from the
   *  headless `conditions` channel. The sessionManager relays this
   *  generically (`session.on('conditions')` →
   *  `manager.emit('conditions', { sessionId, snapshot })` → forwarder →
   *  `session:conditions` → `onSessionConditions` → applyConditionSnapshot
   *  → CLAUDE_VIEWS). This is the wire that RESTORES Claude's dead
   *  trust/permission/resume/compaction modals — previously Claude never
   *  emitted a snapshot so that whole relay was dead for it.
   *
   *  KEPT ALONGSIDE the per-event trust-dialog/resume-prompt/
   *  permission-prompt/compaction-state emissions above: this PR is
   *  additive; the old per-event surface is removed in a later cleanup PR.
   *  `ClaudeConditionSnapshot` is a member of the generic
   *  `ProviderConditionSnapshot` union the sessionManager listens for, so
   *  the relay accepts it without a cast. */
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
  private readonly builtInMcpServers: BuiltInMcpServerConfig[]

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
    this.builtInMcpServers = options.builtInMcpServers ?? []

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
    if (this.builtInMcpServers.length > 0) {
      args.push('--mcp-config', JSON.stringify({
        mcpServers: Object.fromEntries(
          this.builtInMcpServers.map(server => [
            server.name,
            {
              type: 'http',
              url: server.url,
              headers: server.headers,
            },
          ]),
        ),
      }))
    }
    if (this.resumeSessionId) args.push('--resume', this.resumeSessionId)
    if (this.dangerousMode) args.push('--dangerously-skip-permissions')

    const cleanEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(this.env)) {
      if (typeof v === 'string') cleanEnv[k] = v
    }

    // Two spawn paths:
    //   useProxy=false → plain node-pty spawn, screen-driven semantics.
    //   useProxy=true  → start per-session mitmproxy, spawn `claude` with the
    //                    proxy env built inline below (HTTPS_PROXY +
    //                    additive NODE_EXTRA_CA_CERTS), route transport events
    //                    into the adapter.
    //
    // The proxy branch builds its env inline rather than calling the
    // claude-code-headless `spawnClaudeWithProxy` helper. We used to call the
    // helper for the no-arg case and inline only for --resume /
    // --dangerously-skip-permissions, but the two had drifted (the helper also
    // injected trust-store-REPLACING CA vars — see #281 — and silently dropped
    // options.env). Both cases now share one inline env so resume args and CA
    // policy live in exactly one place.
    // WHY this timestamp is captured before the PTY exists:
    //
    // Claude can create its root JSONL transcript almost immediately
    // after spawn. The headless layer needs an IPty instance before it
    // can be constructed, so there is an unavoidable spawn -> tailer
    // wiring window. Passing this timestamp down lets the tailer treat
    // a just-created file as the fresh session transcript even if it
    // already exists by the time the directory watcher snapshots the
    // project dir. Without this, the renderer can receive proxy
    // semantic events forever while committed JSONL stays at zero and
    // providerSessionId is never persisted.
    const freshSessionStartedAtMs = this.resumeSessionId ? null : Date.now()

    if (this.useProxy) {
      // WHY proxy runtime storage must not live under `cwd`:
      //
      // Passing the workspace cwd into createProxyServer made the proxy layer
      // create timestamped runtime directories in whatever project the user had
      // open. That polluted repos with `proxy-events.jsonl`, mitmproxy CA
      // state, and other runtime artifacts. Agent Code owns the storage policy
      // and passes its concrete app-state root into the reusable package.
      // Resolve which mitmdump binary the proxy runtime should
      // spawn. Order of preference:
      //
      //   1. process.env.CLAUDE_HEADLESS_MITMDUMP (or the legacy
      //      CC_PROXY_TEST_MITMDUMP alias) — debug / instrumented
      //      builds. Must win over everything else so contributors can
      //      point this at a hand-built mitmdump without first un-
      //      installing the bundled helper.
      //   2. Bundled artifact unpacked from the packaged app (#119).
      //      Resolves lazily; first call extracts the .app into
      //      userData, subsequent calls return the cached path.
      //   3. Setup-cached PATH path (e.g. user's Homebrew mitmdump).
      //   4. claude-code-headless' own fallback chain (homebrew /
      //      /usr/local lookup) when we pass nothing.
      //
      // WHY we check the env var here even though claude-code-headless
      // also checks it: the package's check only runs when its caller
      // (us) does NOT pass `mitmDumpPath`. If we eagerly resolved the
      // bundled helper and passed it through, the env override would
      // be silently shadowed — exactly the contract violation flagged
      // in the runtimeTools.ts module header. We short-circuit here so
      // bundled resolution and setup-cached lookup are both skipped
      // whenever the env override is set; the package then sees no
      // `mitmDumpPath`, falls into its own fallback chain, and uses
      // the env override.
      //
      // WHY we resolve here and not inside claude-code-headless:
      //   The reusable package must stay Electron-agnostic — it must
      //   not know about app.asar.unpacked or app.getPath('userData').
      //   Agent Code main owns the bundled-helper policy; the package
      //   just spawns whatever path it's handed.
      const envOverrideSet = Boolean(
        process.env.CLAUDE_HEADLESS_MITMDUMP || process.env.CC_PROXY_TEST_MITMDUMP,
      )
      const bundledMitmDump = envOverrideSet
        ? null
        : await resolveBundledTool('mitmdump')
      const setupMitmDump =
        envOverrideSet || bundledMitmDump
          ? null
          : getToolPath('mitmdump', '') || null
      const mitmDumpPath = bundledMitmDump ?? setupMitmDump ?? undefined

      const proxy = await createProxyServer({
        storageRoot: PROXY_EVENTS_DIR,
        confDir: join(PROXY_EVENTS_DIR, '_shared-conf'),
        cwd: this.cwd,
        sessionKey: this.resumeSessionId
          ? `resume-${this.resumeSessionId}`
          : (this.shellSessionId ? `shell-${this.shellSessionId}` : undefined),
        ...(mitmDumpPath ? { mitmDumpPath } : {}),
      })
      await proxy.start()
      this.proxyServer = proxy

      // ONE env for both the no-arg and resume/dangerous spawns. Built inline
      // (no longer via spawnClaudeWithProxy) so CA policy lives in exactly one
      // place. The helper and this block had drifted, and BOTH injected the
      // proxy CA as trust-store-REPLACING single-cert files (SSL_CERT_FILE /
      // CURL_CA_BUNDLE / REQUESTS_CA_BUNDLE). That is the #281 bug: each of
      // those vars replaces the *entire* root store with just the mitmproxy
      // CA, so every host the proxy PASSES THROUGH (npmjs, PyPI, Azure,
      // GitHub, …) presents its real cert and is then rejected — breaking npm,
      // pip, az, curl and git for any tool that reads those vars. It is not a
      // missing-tool problem; it is an actively harmful replace, and chasing it
      // per-tool (adding npm_config_cafile, GIT_SSL_CAINFO, AZURE_*, …) is an
      // unwinnable allowlist.
      //
      // The proxy only MITMs api.anthropic.com (allow_hosts in proxyServer.ts);
      // everything else is a clean TLS passthrough with a real cert, so
      // non-Claude tools need NO CA help whatsoever. The universal, list-free
      // fix is to inject ONLY NODE_EXTRA_CA_CERTS — which is ADDITIVE: it
      // augments the real root store instead of replacing it. Claude (node)
      // then trusts the mitmproxy cert for api.anthropic.com while still
      // trusting real certs for every other host, and every other tool keeps
      // its normal trust and just works. Verified: node→anthropic authorized
      // (issuer mitmproxy), node→npmjs authorized (issuer Google), npm ping OK.
      //
      // Trade-off: a NON-node tool that needs to reach api.anthropic.com
      // THROUGH the proxy would no longer trust the mitm cert. That host is
      // only ever spoken to by Claude itself (node), so this is acceptable; we
      // deliberately do NOT maintain a per-tool CA-var allowlist.
      //
      // cleanEnv already carries TERM/COLORTERM/CLAUDE_CODE_ENTRYPOINT and any
      // options.env overrides, so unifying onto it also fixes the old fast path
      // silently dropping options.env.
      const proxyEnv: Record<string, string> = { ...cleanEnv }
      proxyEnv.HTTPS_PROXY = proxy.info.proxyUrl
      proxyEnv.https_proxy = proxy.info.proxyUrl
      proxyEnv.HTTP_PROXY = proxy.info.proxyUrl
      proxyEnv.http_proxy = proxy.info.proxyUrl
      proxyEnv.NODE_EXTRA_CA_CERTS = proxy.info.caCertPath
      proxyEnv.NO_PROXY = 'localhost,127.0.0.1,::1'
      proxyEnv.no_proxy = proxyEnv.NO_PROXY
      this.pty = ptySpawn(this.binary, args, {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: this.cwd,
        env: proxyEnv,
      })
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
      freshSessionStartedAtMs: freshSessionStartedAtMs ?? undefined,
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
            // Only the current Agent Code env name is honored here. The
            // one-time conversion PR removed the old app env aliases; keeping
            // retired names in runtime code makes future debugging ambiguous
            // because shell state can silently override behavior from a name
            // the app no longer exposes or documents.
            //
            // TODO(model-from-screen): replace this constant default
            // with parsing of Claude Code's header line ("Opus 4.7
            // (1M context) …") so we always know the actual primary
            // model and the env-var escape hatch becomes redundant.
            getSessionModel: () =>
              process.env.AGENT_CODE_PRIMARY_MODEL ??
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

    this.headless.on('screen', snap => {
      this.emit('screen', {
        plain: snap.plain,
        markdown: snap.markdown,
        recent: snap.recent,
        recentMarkdown: snap.recentMarkdown,
        picker: this.headless?.getSlashPickerState() ?? { visible: false, items: [] },
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
    // PR-3: forward the unified conditions snapshot. Mirrors codexSession's
    // `this.headless.on('conditions', s => this.emit('conditions', s))`. This is
    // the single new line that lights up the already-built renderer relay for
    // Claude (the generic sessionManager `conditions` handler does the rest).
    // KEPT ALONGSIDE the four per-event forwards above — additive by design; the
    // old per-event surface is removed in a later cleanup PR.
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

  async resolveCondition(
    action: ConditionCustomAction,
  ): Promise<DriveResult | { ok: false; reason: 'no-headless' }> {
    // WHY this wrapper exists instead of letting SessionManager reach into
    // `headless` directly: ClaudeSession owns the lifecycle boundary. During
    // startup/shutdown the headless instance can legitimately be absent, and the
    // manager should not need to know that provider-internal detail just to run
    // a structured condition resolver.
    if (!this.headless) return { ok: false, reason: 'no-headless' }
    return this.headless.resolveConditionAction(action)
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
