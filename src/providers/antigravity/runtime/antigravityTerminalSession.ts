import { assertAntigravityExternalControlExcluded } from './externalControl.js'
import { spawn } from 'node:child_process'
import { openAgyTurnHooks } from './turnHooks.js'
import { EventEmitter } from 'node:events'
import { AntigravityAcpSession, antigravityConversationExists } from 'antigravity-acp-headless'

import { TerminalSession } from '@shared/runtime/terminalSession.js'
import type { AgentInputReadiness, AgentSession, PromptReadinessOutcome, SessionOptions } from '@shared/types/session.js'
import { openAntigravityNativeMcp } from './nativeMcp.js'
import { openAntigravityIdentityPipe } from './terminalIdentity.js'
import { AntigravityTerminalComposer } from './terminalComposer.js'
import { antigravityTranscriptLocator, registerAntigravityHistory, replayAntigravityConversation } from './antigravityHistory.js'

/** Allocate an exact conversation before launching the TUI so reopening two panes in one directory
 * cannot attach either pane to the other's most recent conversation. No prompt is submitted. */
async function allocateConversation(binary: string, options: SessionOptions, signal: AbortSignal): Promise<string> {
  const env = { ...process.env, ...options.env }
  const child = spawn(binary, ['acp'], {
    cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'ignore'], signal,
  })
  const failed = new Promise<never>((_, reject) => child.once('error', reject))
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  const acp = new AntigravityAcpSession({ input: child.stdout, output: child.stdin, cwd: options.cwd })
  try {
    return (await Promise.race([acp.start(), failed])).sessionId
  } finally {
    await acp.stop()
    child.stdin.end()
    child.kill()
    // Release the temporary ACP writer before agy opens the same store in its interactive mode.
    const timer = setTimeout(() => child.kill('SIGKILL'), 1000)
    try { await closed } finally { clearTimeout(timer) }
  }
}

type TerminalDeps = {
  allocate?: typeof allocateConversation
  prepareTimeoutMs?: number
  resumeTimeoutMs?: number
}

export class AntigravityTerminalSession extends EventEmitter implements AgentSession {
  private readonly startup = new AbortController()
  private terminal: TerminalSession | null = null
  private nativeMcp?: Awaited<ReturnType<typeof openAntigravityNativeMcp>>
  private observer: ReturnType<typeof openAntigravityIdentityPipe> | null = null
  private started = false
  private exited = false
  private turnHooks: Awaited<ReturnType<typeof openAgyTurnHooks>> = null
  private providerSessionId: string | null = null
  readonly nativeComposer: AntigravityTerminalComposer
  private activeConversation: string | null = null
  private history: { id: string; unregister: () => void } | undefined
  private attached = false
  private lastReadiness: AgentInputReadiness['reason'] = 'starting'
  private cols: number
  private rows: number

  constructor(private readonly options: SessionOptions, private readonly deps: TerminalDeps = {}) {
    super()
    this.cols = options.cols ?? 120
    this.rows = options.rows ?? 40
    this.nativeComposer = new AntigravityTerminalComposer(this.cols, this.rows, () => this.publishReadiness())
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('AntigravityTerminalSession already started')
    this.started = true
    this.emit('input-readiness', { ready: false, reason: 'starting' })
    const binary = this.options.binary ?? 'agy'
    const policyEnv = { ...process.env, ...this.options.env }
    const paneServers = [...this.options.builtInMcpServers ?? [], ...this.options.userMcpServers ?? []]
    // Preallocation starts its own agy before the native PTY. In particular,
    // its recoverable sign-in fallback must never swallow a policy conflict.
    await assertAntigravityExternalControlExcluded(this.options.cwd, policyEnv, paneServers)
    if (this.startup.signal.aborted) return
    const requested = this.options.resumeSessionId
    if (requested) {
      // agy silently ignores an unknown --conversation and opens a blank prompt. During a mode
      // switch that would falsely claim success, retiring the pane the user was trying to keep.
      const env = { ...process.env, ...this.options.env }
      if (!antigravityConversationExists(requested, env, env.HOME)) throw new Error('The Antigravity conversation is unavailable. Open a new pane to start a fresh conversation.')
    } else {
      const deadline = AbortSignal.timeout(this.deps.prepareTimeoutMs ?? 5000)
      try {
        const id = await (this.deps.allocate ?? allocateConversation)(binary, this.options, AbortSignal.any([this.startup.signal, deadline]))
        if (this.startup.signal.aborted) return
        this.providerSessionId = id
      } catch {
        if (this.startup.signal.aborted) return
        // Authentication, a stuck ACP startup or an incompatible ACP version should never hide
        // agy's working interactive prompt. Its own identity stream will bind the conversation.
        this.emit('transcript-diagnostic', { kind: 'antigravity-native-preallocation-unavailable' })
      }
    }
    if (this.startup.signal.aborted) return
    const id = requested ?? this.providerSessionId
    // A live PTY can paint a perfectly usable *different* prompt after agy ignores an invalid
    // selection. Only agy's own positive selection may complete an explicit handoff.
    let awaitingResume = Boolean(requested)
    let confirm!: () => void
    let reject!: (error: Error) => void
    const selection = awaitingResume ? new Promise<void>((ok, fail) => { confirm = ok; reject = fail }) : undefined
    const failResume = (message: string) => {
      if (awaitingResume) reject(new Error(message))
    }
    await assertAntigravityExternalControlExcluded(this.options.cwd, policyEnv, paneServers)
    if (this.startup.signal.aborted) return
    this.nativeMcp = await openAntigravityNativeMcp(this.options)
    if (this.startup.signal.aborted) { this.closeObserver(); return }
    try {
      this.turnHooks = await openAgyTurnHooks(this.options.builtInMcpServers ?? [], () => this.activeConversation,
        (active, turnInterrupted) => this.emit('process-state', { active, turnInterrupted }))
      if (this.startup.signal.aborted) { this.closeObserver(); return }
      this.observer = openAntigravityIdentityPipe({
        active: next => {
          if (this.startup.signal.aborted || this.exited) return
          this.activeConversation = next
          if (awaitingResume) {
            if (next === requested) confirm()
            else failResume('Antigravity opened a different conversation.')
            return
          }
          if (this.providerSessionId === next) { this.publishReadiness(); return }
          this.providerSessionId = next
          this.publishReadiness()
          const transcriptFile = antigravityTranscriptLocator(next)
          this.emit('provider-session-changed', { providerSessionId: next, transcriptFile, reason: 'antigravity-native-conversation' })
          this.emit('jsonl-entry', { type: 'antigravity-identity', sessionId: next }, transcriptFile)
        },
        missing: missing => {
          if (missing === requested) failResume('The requested Antigravity conversation is unavailable.')
        },
        error: () => {
          failResume('Could not verify the requested Antigravity conversation.')
          this.emit('transcript-diagnostic', { kind: 'antigravity-native-identity-unavailable' })
        },
      })
    } catch (error) {
      this.closeObserver()
      throw error
    }
    const args = ['--log-file', this.observer.path]
    if (id) args.push('--conversation', id)
    if (this.nativeMcp) args.push('--add-dir', this.nativeMcp.directory)
    if (this.turnHooks) args.push('--add-dir', this.turnHooks.workspace)
    const options = {
      shell: binary, args, cwd: this.options.cwd,
      cols: this.cols, rows: this.rows, env: this.options.env,
    }
    const terminal = new TerminalSession(options)
    this.terminal = terminal
    terminal.on('data', data => {
      void this.nativeComposer.output(data)
      this.emit('pty-data', data)
    })
    terminal.on('exit', exit => {
      this.exited = true
      failResume('Antigravity exited before confirming the requested conversation.')
      this.emit('input-readiness', { ready: false, reason: 'provider-not-ready' })
      this.nativeComposer.dispose()
      this.closeObserver()
      this.emit('exit', exit)
    })
    const cancel = () => failResume('Antigravity conversation resume was cancelled.')
    const timer = selection && setTimeout(() => failResume('Antigravity timed out confirming the requested conversation.'), this.deps.resumeTimeoutMs ?? 10_000)
    this.startup.signal.addEventListener('abort', cancel, { once: true })
    try {
      await Promise.all([terminal.start().then(() => this.nativeMcp?.setOwner(terminal.getProcessPid())), selection])
      if (requested) {
        if (this.startup.signal.aborted) throw new Error('Antigravity conversation resume was cancelled.')
        if (this.exited) throw new Error('Antigravity exited during conversation resume.')
        this.providerSessionId = requested
      }
    } catch (error) {
      this.exited = true
      await terminal.stop()
      this.nativeComposer.dispose()
      this.closeObserver()
      throw error
    } finally {
      awaitingResume = false
      this.startup.signal.removeEventListener('abort', cancel)
      clearTimeout(timer)
    }
    if (this.startup.signal.aborted || this.exited) return
    if (id) {
      const transcriptFile = antigravityTranscriptLocator(id)
      this.emit('jsonl-entry', { type: 'antigravity-identity', sessionId: id }, transcriptFile)
    }
    this.attached = true
    this.publishReadiness()
    this.emit('started', {})
  }

  confirmedConversation(): string | null {
    return this.attached && !this.isExited() && this.activeConversation === this.providerSessionId
      ? this.activeConversation : null
  }

  private publishReadiness(): void {
    const id = this.confirmedConversation()
    if ((this.history?.id ?? null) !== id) {
      this.history?.unregister()
      this.history = undefined
      if (id) {
        // Never infer replay configuration from a transcript-reader request. agy
        // authenticated this conversation; reuse its trusted cwd, binary and profile.
        // Share overlapping reads, then discard the result so a new turn is visible.
        const lifetime = new AbortController()
        let pending: ReturnType<typeof replayAntigravityConversation> | undefined
        const replay = () => pending ??= replayAntigravityConversation(id, this.options.cwd, {
          binary: this.options.binary, env: { ...process.env, ...this.options.env }, signal: lifetime.signal,
        }).finally(() => { pending = undefined })
        const release = registerAntigravityHistory(id, { replay })
        this.history = { id, unregister: () => { release(); lifetime.abort() } }
      }
    }
    const ready = Boolean(id) && this.nativeComposer.ready()
    const reason = ready ? 'ready' : this.nativeComposer.occupied() ? 'composer-occupied' : 'provider-not-ready'
    if (reason !== this.lastReadiness) {
      this.lastReadiness = reason
      this.emit('input-readiness', { ready, reason })
    }
  }

  async awaitReadyForPrompt(options: { deadlineAt?: number; timeoutMs?: number } = {}): Promise<PromptReadinessOutcome> {
    // The manager can now hold one follow-up for a booting pane, released by
    // a real paint, without reserving the keyboard during sign-in or trust.
    const start = Date.now()
    const deadline = options.deadlineAt ?? start + (options.timeoutMs ?? 2000)
    return new Promise(resolve => {
      const settle = (expired = false) => {
        let state: PromptReadinessOutcome
        if (this.isExited()) state = { kind: 'terminal', reason: 'exited' }
        else if (this.confirmedConversation() && this.nativeComposer.ready()) state = { kind: 'ready', waitedMs: Date.now() - start }
        else if (this.nativeComposer.occupied()) state = { kind: 'occupied', reason: 'human-draft' }
        else if (expired) state = { kind: 'timeout', waitedMs: Date.now() - start, lastState: { kind: 'warming', reason: 'composer-unpainted' } }
        else return
        clearTimeout(timer)
        this.off('input-readiness', onState)
        this.off('exit', onState)
        this.startup.signal.removeEventListener('abort', onState)
        resolve(state)
      }
      const onState = () => settle()
      const timer = setTimeout(() => settle(true), Math.max(0, deadline - start))
      this.on('input-readiness', onState)
      this.on('exit', onState)
      this.startup.signal.addEventListener('abort', onState, { once: true })
      settle()
    })
  }

  write(data: string): boolean {
    if (!this.terminal || this.exited || this.startup.signal.aborted) return false
    this.nativeComposer.input(data)
    this.terminal.write(data)
    return true
  }

  resize(cols: number, rows: number): void {
    if (cols < 1 || rows < 1) return
    this.cols = cols
    this.rows = rows
    this.nativeComposer.resize(cols, rows)
    this.terminal?.resize(cols, rows)
  }

  async stop(): Promise<void> {
    this.startup.abort()
    await this.terminal?.stop()
    this.nativeComposer.dispose()
    this.closeObserver()
  }

  private closeObserver(): void {
    void this.turnHooks?.close()
    this.turnHooks = null
    this.history?.unregister()
    this.history = undefined
    this.observer?.close()
    this.observer = null
    this.nativeMcp?.close()
    this.nativeMcp = undefined
  }

  getProcessPid(): number | null { return this.terminal?.getProcessPid() ?? null }
  isExited(): boolean { return this.exited || this.startup.signal.aborted }
  getProviderSessionId(): string | null { return this.providerSessionId }
  getTranscriptFile(): string | null {
    return this.providerSessionId ? antigravityTranscriptLocator(this.providerSessionId) : null
  }
}
