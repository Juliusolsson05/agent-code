import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { AntigravityAcpSession, antigravityConversationExists } from 'antigravity-acp-headless'

import { TerminalSession } from '@shared/runtime/terminalSession.js'
import type { AgentSession, SessionOptions } from '@shared/types/session.js'
import { openAntigravityIdentityPipe } from './terminalIdentity.js'
import { antigravityTranscriptLocator } from './antigravityHistory.js'

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
  private observer: ReturnType<typeof openAntigravityIdentityPipe> | null = null
  private started = false
  private exited = false
  private providerSessionId: string | null = null
  private cols: number
  private rows: number

  constructor(private readonly options: SessionOptions, private readonly deps: TerminalDeps = {}) {
    super()
    this.cols = options.cols ?? 120
    this.rows = options.rows ?? 40
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('AntigravityTerminalSession already started')
    this.started = true
    this.emit('input-readiness', { ready: false, reason: 'starting' })
    const binary = this.options.binary ?? 'agy'
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
    this.observer = openAntigravityIdentityPipe({
      active: next => {
        if (this.startup.signal.aborted || this.exited) return
        if (awaitingResume) {
          if (next === requested) confirm()
          else failResume('Antigravity opened a different conversation.')
          return
        }
        if (this.providerSessionId === next) return
        this.providerSessionId = next
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
    const args = ['--log-file', this.observer.path]
    if (id) args.push('--conversation', id)
    const options = {
      shell: binary, args, cwd: this.options.cwd,
      cols: this.cols, rows: this.rows, env: this.options.env,
    }
    const terminal = new TerminalSession(options)
    this.terminal = terminal
    terminal.on('data', data => this.emit('pty-data', data))
    // The terminal can accept human input, including sign-in and trust choices, as soon as the
    // PTY is running. Automated prompt delivery is a separate ACP-only capability.
    let painted = false
    terminal.once('data', () => {
      painted = true
      if (!awaitingResume && !this.startup.signal.aborted && !this.exited) this.emit('input-readiness', { ready: true, reason: 'ready' })
    })
    terminal.on('exit', exit => {
      this.exited = true
      failResume('Antigravity exited before confirming the requested conversation.')
      this.emit('input-readiness', { ready: false, reason: 'provider-not-ready' })
      this.closeObserver()
      this.emit('exit', exit)
    })
    const cancel = () => failResume('Antigravity conversation resume was cancelled.')
    const timer = selection && setTimeout(() => failResume('Antigravity timed out confirming the requested conversation.'), this.deps.resumeTimeoutMs ?? 10_000)
    this.startup.signal.addEventListener('abort', cancel, { once: true })
    try {
      await Promise.all([terminal.start(), selection])
      if (requested) {
        if (this.startup.signal.aborted) throw new Error('Antigravity conversation resume was cancelled.')
        if (this.exited) throw new Error('Antigravity exited during conversation resume.')
        this.providerSessionId = requested
        if (painted) this.emit('input-readiness', { ready: true, reason: 'ready' })
      }
    } catch (error) {
      this.exited = true
      await terminal.stop()
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
    this.emit('started', {})
  }

  write(data: string): boolean {
    if (!this.terminal || this.exited || this.startup.signal.aborted) return false
    this.terminal.write(data)
    return true
  }

  resize(cols: number, rows: number): void {
    if (cols < 1 || rows < 1) return
    this.cols = cols
    this.rows = rows
    this.terminal?.resize(cols, rows)
  }

  async stop(): Promise<void> {
    this.startup.abort()
    await this.terminal?.stop()
    this.closeObserver()
  }

  private closeObserver(): void {
    this.observer?.close()
    this.observer = null
  }

  getProcessPid(): number | null { return this.terminal?.getProcessPid() ?? null }
  isExited(): boolean { return this.exited || this.startup.signal.aborted }
  getProviderSessionId(): string | null { return this.providerSessionId }
  getTranscriptFile(): string | null {
    return this.providerSessionId ? antigravityTranscriptLocator(this.providerSessionId) : null
  }
}
