import { EventEmitter } from 'node:events'
import { constants as osConstants } from 'node:os'
import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  AntigravityAcpSession,
  antigravityConversationExists,
  type AntigravityMcpServer,
} from 'antigravity-acp-headless'

import type { AgentSession, AgentSessionEvents, SessionOptions } from '@shared/types/session.js'
import type { ConditionCustomAction } from '@shared/types/providerConditions.js'
import { asRecord } from '@shared/lib/asRecord.js'
import { registerAntigravityHistory, antigravityTranscriptLocator } from '@providers/antigravity/runtime/antigravityHistory.js'
import { resolveAntigravityMcpProxyScript, resolveAntigravityScriptRunner } from '@providers/antigravity/runtime/runtimeScripts.js'

/** Nothing reached agy: not started, stopped, or agy exited. Retry is safe. */
class AntigravityNotReadyError extends Error {
  readonly code = 'antigravity-not-ready'
}

export const ANTIGRAVITY_PERMISSION_RESPOND = 'antigravity.permission.respond'

/**
 * Injection seams: tests replace the process spawn (a fake `agy acp` speaking
 * recorded frames); the ACP session is always the real package.
 */
export type AntigravitySessionDeps = {
  spawn?: (binary: string, args: string[], options: { cwd: string; env: Record<string, string> }) => ChildProcessWithoutNullStreams
  mcpProxyScript?: string
  scriptRunner?: string
  conversationExists?: (sessionId: string, env: Record<string, string>) => boolean
}

export interface AntigravitySession {
  on<K extends keyof AgentSessionEvents>(event: K, listener: (...args: AgentSessionEvents[K]) => void): this
  off<K extends keyof AgentSessionEvents>(event: K, listener: (...args: AgentSessionEvents[K]) => void): this
  once<K extends keyof AgentSessionEvents>(event: K, listener: (...args: AgentSessionEvents[K]) => void): this
  emit<K extends keyof AgentSessionEvents>(event: K, ...args: AgentSessionEvents[K]): boolean
}

/**
 * Google Antigravity (the `agy` CLI) as a structured provider: Agent Code
 * spawns `agy acp` and drives it over the Agent Client Protocol through
 * antigravity-acp-headless. This runtime powers the rendered feed. The terminal
 * runtime opens the same conversation in agy's interactive TUI with `agy --conversation <id>` because both share agy's store.
 *
 * Auth is agy's own: the user signs in once in agy (Google account, AI
 * Pro/Ultra plans included); Agent Code never sees a credential.
 *
 * Identity: agy assigns the id (session/new takes none), so a fresh pane binds
 * its provider session the moment session/new answers. A resumed pane calls
 * session/load, which replays the conversation as a history reset. A
 * conversation agy no longer holds (deleted) starts a NEW conversation and
 * says so through provider-session-changed rather than failing the pane.
 *
 * dangerousMode → session mode... is NOT mapped: ACP has no auto-approve
 * switch in agy 1.5.15's session/new, and silently approving every permission
 * request client-side would hide from the user exactly what dangerous mode
 * is meant to skip — the Allow/Deny cards stay, each one click.
 */
export class AntigravitySession extends EventEmitter implements AgentSession {
  private child: ChildProcessWithoutNullStreams | null = null
  private acp: AntigravityAcpSession | null = null
  private exited = false
  private stopping = false
  private providerSessionId: string | null = null
  private unregisterHistory: (() => void) | null = null
  private historyGeneration = 0
  /**
   * Offset for history generations. The package numbers resets from 1 per
   * instance, but a pane OUTLIVES its session: Reload Agent and recovery build
   * a new AntigravitySession for the same pane, and the renderer drops a reset
   * whose generation is not above the last it applied (historyBoundary.ts
   * decideHistoryBoundary). A dropped reset leaves the old dedup set in place,
   * so the replayed rows — same keys — were discarded as duplicates and the
   * reloaded pane came up EMPTY (seen live in the dev app). Wall-clock micros
   * keep generations rising across lifetimes; Hermes uses the same base.
   */
  private readonly generationBase = Date.now() * 1000
  private spawnFailed = false

  private readonly cwd: string
  private readonly binary: string
  private readonly extraEnv: Record<string, string | undefined>
  private readonly resumeSessionId: string | null
  private readonly builtInMcpServers: NonNullable<SessionOptions['builtInMcpServers']>
  private readonly deps: Required<AntigravitySessionDeps>

  constructor(options: SessionOptions, deps: AntigravitySessionDeps = {}) {
    super()
    this.cwd = options.cwd
    this.binary = options.binary ?? 'agy'
    this.extraEnv = options.env ?? {}
    this.resumeSessionId = options.resumeSessionId ?? null
    this.builtInMcpServers = options.builtInMcpServers ?? []
    this.deps = {
      spawn: deps.spawn ?? ((binary, args, spawnOptions) => spawnProcess(binary, args, { ...spawnOptions, stdio: ['pipe', 'pipe', 'pipe'] })),
      mcpProxyScript: deps.mcpProxyScript ?? resolveAntigravityMcpProxyScript(),
      scriptRunner: deps.scriptRunner ?? resolveAntigravityScriptRunner(),
      conversationExists: deps.conversationExists ?? ((id, env) => antigravityConversationExists(id, env)),
    }
  }

  async start(): Promise<void> {
    if (this.child) throw new Error('AntigravitySession already started')
    this.exited = false
    this.emit('input-readiness', { ready: false, reason: 'starting' })

    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') env[key] = value
    for (const [key, value] of Object.entries(this.extraEnv)) {
      if (value === undefined) delete env[key]
      else env[key] = value
    }

    const child = this.deps.spawn(this.binary, ['acp'], { cwd: this.cwd, env })
    this.child = child
    // agy logs to stderr; drained so a chatty run can never fill the pipe and
    // stall the agent.
    child.stderr.on('data', () => {})
    child.on('exit', (code, signal) => this.onExit(code, signal))
    child.on('error', error => {
      this.spawnFailed = true
      this.emit('jsonl-error', Object.assign(new Error(`Could not start agy: ${error.message}`), { code: 'spawn-failed' }))
      this.onExit(null, null)
    })

    // A conversation whose store file is plainly gone is not even tried; any
    // other resume goes to session/load, and the package falls back to a new
    // conversation if agy refuses it. The check reads the PANE's environment
    // (GEMINI_CLI_HOME may differ from main's), and it is only a shortcut:
    // agy's answer is what decides.
    const resume = this.resumeSessionId && this.deps.conversationExists(this.resumeSessionId, env) ? this.resumeSessionId : null
    const acp = new AntigravityAcpSession({
      input: child.stdout,
      output: child.stdin,
      cwd: this.cwd,
      resumeSessionId: resume,
      mcpServers: this.mcpServers(),
      clientInfo: { name: 'agent-code', version: '1' },
    })
    this.acp = acp
    this.forward(acp)

    let started: { sessionId: string; resumed: boolean }
    try {
      started = await acp.start()
    } catch (error) {
      await this.stop()
      throw new Error(`agy acp did not start: ${error instanceof Error ? error.message : String(error)}. Run \`agy\` once in a terminal to sign in.`)
    }
    if (this.acp !== acp || this.exited) return
    const fellBack = Boolean(this.resumeSessionId && !started.resumed)
    this.bindIdentity(started.sessionId, fellBack ? 'antigravity-conversation-missing' : null)
    if (fellBack && !resume) {
      // Skipped the load (the shortcut above), so the package sent no reset:
      // the pane still shows the conversation it asked for, and this one is
      // different. The package sends this itself when agy refused the load.
      this.emit('history-boundary', { type: 'reset', generation: this.generationBase + ++this.historyGeneration, snapshotByteLength: 0, complete: false, conversationChanged: true, file: antigravityTranscriptLocator(started.sessionId) })
      this.emit('history-boundary', { type: 'caught-up', generation: this.generationBase + this.historyGeneration, snapshotByteLength: 0, complete: true, file: antigravityTranscriptLocator(started.sessionId) })
    }
    this.emit('process-state', { active: false })
    this.emit('input-readiness', { ready: true, reason: 'ready' })
    this.emit('started', {})
  }

  /**
   * Agent Code's built-in MCP endpoint as a stdio server agy starts itself
   * (agy advertises no HTTP MCP support over ACP). Header values travel in the
   * server's env list, never in argv.
   */
  private mcpServers(): AntigravityMcpServer[] {
    if (this.builtInMcpServers.length === 0) return []
    const env: Array<{ name: string; value: string }> = [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }]
    const specs = this.builtInMcpServers.map((server, serverIndex) => {
      const headers = { ...server.headers, ...(server.bearerToken === undefined ? {} : { Authorization: `Bearer ${server.bearerToken}` }) }
      const headerEnv: Record<string, string> = {}
      Object.entries(headers).forEach(([header, value], headerIndex) => {
        const variable = `AGENT_CODE_MCP_${serverIndex}_${headerIndex}`
        env.push({ name: variable, value })
        headerEnv[header] = variable
      })
      return { name: server.name, url: server.url, headerEnv }
    })
    env.push({ name: 'AGENT_CODE_ACP_MCP_SERVERS', value: JSON.stringify(specs) })
    return [{ type: 'stdio', name: this.builtInMcpServers[0]!.name, command: this.deps.scriptRunner, args: [this.deps.mcpProxyScript], env }]
  }

  private bindIdentity(sessionId: string, changedReason: string | null): void {
    const previous = this.providerSessionId
    this.providerSessionId = sessionId
    this.unregisterHistory?.()
    this.unregisterHistory = registerAntigravityHistory(sessionId, { rows: () => this.acp?.getRows() ?? [] })
    if (changedReason || (previous && previous !== sessionId)) {
      this.emit('provider-session-changed', { providerSessionId: sessionId, transcriptFile: antigravityTranscriptLocator(sessionId), reason: changedReason ?? 'antigravity-new-conversation' })
    }
    // Identity before any row, so the renderer binds the pane at once (the
    // Antigravity mapper renders no row for this envelope).
    this.emit('jsonl-entry', { type: 'antigravity-identity', sessionId }, antigravityTranscriptLocator(sessionId))
  }

  private forward(acp: AntigravityAcpSession): void {
    acp.on('row', row => {
      this.emit('jsonl-entry', row as unknown as Record<string, unknown>, antigravityTranscriptLocator(row.sessionId))
    })
    acp.on('history', ({ kind, conversationChanged }) => {
      if (kind === 'reset') this.historyGeneration += 1
      this.emit('history-boundary', {
        type: kind,
        generation: this.generationBase + this.historyGeneration,
        snapshotByteLength: 0,
        complete: kind === 'caught-up',
        ...(kind === 'reset' && conversationChanged ? { conversationChanged: true } : {}),
        file: antigravityTranscriptLocator(this.providerSessionId ?? this.resumeSessionId ?? ''),
      })
    })
    acp.on('semantic', event => this.emit('semantic-event', event))
    acp.on('activity', ({ active, status }) => this.emit('process-state', { active, status }))
    acp.on('conditions', snapshot => this.emit('conditions', snapshot as unknown as AgentSessionEvents['conditions'][0]))
    acp.on('error', ({ code, message }) => this.emit('transcript-diagnostic', { kind: 'antigravity-acp-error', code, message }))
    acp.on('closed', ({ reason }) => {
      this.emit('transcript-diagnostic', { kind: 'antigravity-acp-closed', reason })
      // The protocol died but agy may still be running (an oversized frame, a
      // write error). A pane that looks ready while every prompt fails is
      // worse than an exited one: end agy so the normal exit path runs.
      if (!this.stopping && !this.exited) {
        try {
          this.child?.kill()
        } catch {
          // already gone
        }
      }
    })
  }

  /** Structured runtime: no PTY. Esc (the app's universal interrupt) cancels the turn. */
  write(data: string): boolean {
    if (data === '\x1b' && this.acp) {
      this.acp.cancel()
      return true
    }
    return false
  }

  resize(_cols: number, _rows: number): void {}

  /**
   * Hand a prompt to agy. Resolves `{ turnStarted: false }` at once when a
   * turn is already running: the prompt is queued in order behind it (ACP runs
   * one session/prompt at a time), and deliverAntigravityPrompt reports that
   * as a `queue` acceptance. WHY not wait for the queued prompt to be written:
   * that happens only when the running turn ends, possibly much later, and
   * SessionManager holds the pane's delivery slot for as long as this promise
   * is pending, so every other delivery to the pane would fail with
   * delivery-in-flight in the meantime.
   */
  async deliverPromptText(text: string): Promise<{ turnStarted: boolean }> {
    const acp = this.acp
    if (!acp || this.exited || !this.providerSessionId) throw new AntigravityNotReadyError('agy is not running')
    const queued = acp.isTurnActive()
    const { accepted, finished } = acp.prompt(text)
    // The turn's outcome arrives as semantic events. A QUEUED prompt that never
    // ran because agy stopped first is said once, so it is not lost silently.
    finished.catch(error => {
      if (queued) this.emit('transcript-diagnostic', { kind: 'antigravity-queued-prompt-dropped', message: error instanceof Error ? error.message : String(error) })
    })
    if (queued) {
      accepted.catch(() => undefined)
      return { turnStarted: false }
    }
    try {
      await accepted
    } catch (error) {
      throw new AntigravityNotReadyError(error instanceof Error ? error.message : String(error))
    }
    return { turnStarted: true }
  }

  async resolveCondition(action: ConditionCustomAction): Promise<{ ok: true; state?: unknown } | { ok: false; reason: string }> {
    if (!this.acp) return { ok: false, reason: 'no-headless' }
    if (action.name !== ANTIGRAVITY_PERMISSION_RESPOND) return { ok: false, reason: 'no-resolver' }
    const payload = asRecord(action.payload)
    const requestKey = typeof payload?.requestKey === 'string' ? payload.requestKey : null
    const optionId = typeof payload?.optionId === 'string' ? payload.optionId : null
    // Answer only a request that is STILL open, with one of ITS options (the
    // OpenCode #1068 lesson: validate against the live record, never trust a
    // stale card).
    if (!requestKey || !optionId || !this.acp.respondPermission(requestKey, optionId)) return { ok: false, reason: 'invalid-payload' }
    return { ok: true }
  }

  getProcessPid(): number | null {
    return this.child?.pid ?? null
  }

  isExited(): boolean {
    return this.exited
  }

  getTranscriptFile(): string | null {
    return this.providerSessionId ? antigravityTranscriptLocator(this.providerSessionId) : null
  }

  getProviderSessionId(): string | null {
    return this.providerSessionId
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return
    this.exited = true
    // An exited pane no longer owns the conversation: the user may continue
    // it in agy's own TUI (`agy --conversation`), and history / catalog reads
    // must then replay it fresh instead of serving these stale rows.
    this.unregisterHistory?.()
    this.unregisterHistory = null
    void this.acp?.stop()
    this.emit('input-readiness', { ready: false, reason: 'provider-not-ready' })
    this.emit('process-state', { active: false })
    // A spawn failure already reported itself as spawn-failed.
    if (!this.stopping && !this.spawnFailed && code !== 0) {
      this.emit('jsonl-error', Object.assign(new Error(`agy exited (${signal ?? code ?? 'unknown'}). If this keeps happening, run \`agy\` in a terminal to check its sign-in.`), { code: 'agy-exited' }))
    }
    const signalNumber = signal ? (osConstants.signals as Record<string, number>)[signal] : undefined
    this.emit('exit', { exitCode: code ?? 1, ...(signalNumber !== undefined ? { signal: signalNumber } : {}) })
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.unregisterHistory?.()
    this.unregisterHistory = null
    const acp = this.acp
    this.acp = null
    await acp?.stop()
    const child = this.child
    if (child && !this.exited) {
      try {
        child.kill()
      } catch {
        // already gone
      }
    }
  }
}
