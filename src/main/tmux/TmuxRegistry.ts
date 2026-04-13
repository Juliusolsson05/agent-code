// TmuxRegistry — main-side service that owns every cc-shell-managed
// tmux session.
//
// Why a registry rather than per-session methods:
//   - tmux availability has to be checked once at startup, not per
//     session-spawn. A registry holds that flag.
//   - On launch we have to reconcile persisted state with `tmux ls`
//     output before any session spawns. That reconciliation needs a
//     single object that knows the naming convention.
//   - Future phases (P3 agents, P4 dispatch) will reuse this exact
//     surface. Keeping it in one place means there's no drift.

import { spawn as childSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { TMUX_SESSION_FLAGS } from './tmuxConfig.js'

export type TmuxRegistryOptions = {
  /** All session names this registry manages will start with this
   *  prefix. Production uses 'ccshell-'; tests use a different
   *  prefix so they never touch the user's real sessions. */
  namePrefix?: string
  /** Override for the tmux binary path. Defaults to 'tmux' on PATH. */
  tmuxBinary?: string
}

export class TmuxRegistry {
  private readonly namePrefix: string
  private readonly tmuxBinary: string
  private availability: boolean | null = null

  constructor(options: TmuxRegistryOptions = {}) {
    this.namePrefix = options.namePrefix ?? 'ccshell-'
    this.tmuxBinary = options.tmuxBinary ?? 'tmux'
  }

  /**
   * Resolve true iff `tmux -V` exits 0. Result is cached for the
   * lifetime of the registry — tmux doesn't get installed mid-session
   * in any realistic scenario, and re-checking on every spawn would
   * add latency to every terminal open.
   */
  async detectAvailability(): Promise<boolean> {
    if (this.availability !== null) return this.availability
    this.availability = await new Promise<boolean>(resolve => {
      const proc = childSpawn(this.tmuxBinary, ['-V'], { stdio: 'ignore' })
      proc.on('error', () => resolve(false))
      proc.on('exit', code => resolve(code === 0))
    })
    return this.availability
  }

  /** Synchronous read of the cached availability flag. Throws if
   *  detectAvailability() hasn't run yet — callers must await
   *  detection during app startup before using the registry. */
  isAvailable(): boolean {
    if (this.availability === null) {
      throw new Error('TmuxRegistry: call detectAvailability() before isAvailable()')
    }
    return this.availability
  }

  /** Generate a fresh, unique session name in this registry's namespace. */
  generateName(): string {
    return `${this.namePrefix}${randomUUID()}`
  }

  /** True iff a tmux session with the given name exists. */
  async sessionExists(name: string): Promise<boolean> {
    return new Promise(resolve => {
      const proc = childSpawn(
        this.tmuxBinary,
        ['has-session', '-t', name],
        { stdio: 'ignore' },
      )
      proc.on('error', () => resolve(false))
      proc.on('exit', code => resolve(code === 0))
    })
  }

  /**
   * Create a detached tmux session running `command`. The session has
   * UI-suppression flags applied before the renderer ever attaches.
   *
   * Detached because the registry's job is to OWN the session — the
   * subsequent attach-as-child-PTY happens in TerminalSession.
   */
  async createSession(opts: {
    name: string
    command: string
    args?: string[]
    cwd?: string
  }): Promise<void> {
    await this.runTmux([
      'new-session',
      '-d',                  // detached — don't block on a foreground attach
      '-s', opts.name,
      '-c', opts.cwd ?? process.cwd(),
      opts.command,
      ...(opts.args ?? []),
    ])

    // Apply UI-suppression flags. Each `set -t <name>` is a separate
    // call because chaining them is finicky and the cost of N short
    // process spawns at session-create time is irrelevant.
    for (const [key, value] of TMUX_SESSION_FLAGS) {
      await this.runTmux(['set', '-t', opts.name, key, value])
    }
  }

  /** Kill a session by name. No-op if it doesn't exist. */
  async killSession(name: string): Promise<void> {
    if (!(await this.sessionExists(name))) return
    await this.runTmux(['kill-session', '-t', name])
  }

  /**
   * Return every tmux session whose name starts with this registry's
   * prefix. Used during launch reconciliation to discover sessions
   * that survived a previous cc-shell run.
   *
   * Returns [] if tmux is unavailable OR if there are no managed
   * sessions — callers shouldn't have to distinguish those cases here
   * (they are different concerns: availability is checked separately
   * at startup, this method just answers "what's alive right now").
   */
  async listManagedSessions(): Promise<Array<{ name: string; createdAt: number }>> {
    if (!this.availability) return []

    // -F format string returns one session per line, fields separated
    // by a literal '|' which is illegal in tmux session names so we
    // can safely split on it.
    const out = await this.runTmuxCapture([
      'list-sessions',
      '-F', '#{session_name}|#{session_created}',
    ]).catch(() => '')   // exit-code 1 means "no sessions" — treat as empty

    return out
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => {
        const [name, createdStr] = line.split('|')
        return { name, createdAt: Number(createdStr) * 1000 }
      })
      .filter(s => s.name.startsWith(this.namePrefix))
  }

  /** Run a tmux command, resolving with stdout. Reject on non-zero. */
  private runTmuxCapture(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = childSpawn(this.tmuxBinary, args)
      let stdout = ''
      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
      proc.on('error', reject)
      proc.on('exit', code => {
        if (code === 0) resolve(stdout)
        else reject(new Error(`tmux ${args.join(' ')} exited ${code}`))
      })
    })
  }

  /** Run a tmux command, resolving once it exits 0; reject on non-zero. */
  private runTmux(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = childSpawn(this.tmuxBinary, args, { stdio: 'ignore' })
      proc.on('error', reject)
      proc.on('exit', code => {
        if (code === 0) resolve()
        else reject(new Error(`tmux ${args.join(' ')} exited ${code}`))
      })
    })
  }
}
