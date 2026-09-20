// TmuxRegistry — main-side service that owns every Agent Code-managed
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

import { TMUX_SESSION_FLAGS } from '@main/tmux/tmuxConfig.js'
import type { TerminalForegroundSample } from '@shared/types/terminalForeground.js'

// One `list-panes -a` answers for every session on the server. Tab-separated
// because none of the first four fields can contain a tab (session names are
// prefix + UUID, window_active/pane_active are 0/1, command names are process
// names), so a path containing tabs is recovered by joining whatever follows
// the fourth tab.
//
// WHY #{window_active} is included (M4): a session can have more than one
// window (a user can create one with the prefix key, same as splitting a
// pane), and tmux tracks an "active pane" PER WINDOW — a background window's
// own active pane still reports pane_active=1 for itself. Reading
// pane_active alone therefore matched whichever window's active-pane line
// happened to sort last in `list-panes -a`'s output, not necessarily the
// window an attached client (or attach-as-child-PTY renderer) is actually
// showing. Only the pane that is both its window's active pane AND inside
// the session's active window is the one that's really in the foreground.
const PANE_FOREGROUND_FORMAT =
  '#{session_name}\t#{window_active}\t#{pane_active}\t#{pane_current_command}\t#{pane_current_path}'

export function parsePaneForegroundListing(
  output: string,
  namePrefix: string,
): Map<string, TerminalForegroundSample> {
  const panes = new Map<string, TerminalForegroundSample & { active: boolean }>()
  for (const line of output.split('\n')) {
    if (!line) continue
    const [name, windowActive, paneActive, command, ...pathParts] = line.split('\t')
    // The default tmux server is shared with the user's own sessions; only
    // prefixed names are ours to report.
    if (!name?.startsWith(namePrefix) || command === undefined) continue
    // See the format string's WHY comment: both flags must be '1' for this
    // pane to be the one actually visible to an attached client.
    const isActive = paneActive === '1' && windowActive === '1'
    // Agent Code sessions have one pane, but a user can split one with the
    // prefix key or open a second window. The active pane is the one the
    // attached client shows.
    if (panes.get(name)?.active && !isActive) continue
    panes.set(name, { command: command || null, cwd: pathParts.join('\t') || null, active: isActive })
  }
  return new Map([...panes].map(([name, { command, cwd }]) => [name, { command, cwd }]))
}

export type TmuxRegistryOptions = {
  /** All new session names this registry manages will start with this
   *  prefix. Production uses 'agentcode-'; tests use a different
   *  prefix so they never touch the user's real sessions. */
  namePrefix?: string
  /**
   * Absolute path to the tmux binary the registry should spawn.
   * Undefined means "no bundled tmux is available" — the registry
   * resolves `detectAvailability()` to false WITHOUT spawning
   * anything, and terminals fall back to direct-PTY mode. This is
   * the bundled-only policy from #120: we never go looking for a
   * PATH tmux even as a last resort, because a user's Homebrew tmux
   * could be a different version with an incompatible session
   * format.
   */
  tmuxBinary?: string
}

export class TmuxRegistry {
  private readonly namePrefix: string
  private readonly tmuxBinary: string | null
  private availability: boolean | null = null

  constructor(options: TmuxRegistryOptions = {}) {
    this.namePrefix = options.namePrefix ?? 'agentcode-'
    // WHY we store `null` instead of falling back to `'tmux'`:
    //   A bare command name would get PATH-searched by node-pty /
    //   child_process.spawn. The bundled-only policy says: if we
    //   could not resolve a bundled tmux, do not run any tmux. A
    //   sentinel like `'tmux-bundled-missing'` would still get
    //   PATH-searched (and in the unlikely case of a name collision
    //   would invoke whatever happened to be on PATH). Storing null
    //   and short-circuiting at every call site is the clean
    //   version.
    this.tmuxBinary = options.tmuxBinary ?? null
  }

  /**
   * Resolve true iff `tmux -V` exits 0. Result is cached for the
   * lifetime of the registry — tmux doesn't get installed mid-session
   * in any realistic scenario, and re-checking on every spawn would
   * add latency to every terminal open.
   *
   * Returns false immediately without spawning anything when no
   * tmuxBinary was supplied at construction — that path encodes the
   * "bundled tmux unavailable" outcome from the runtime resolver.
   */
  async detectAvailability(): Promise<boolean> {
    if (this.availability !== null) return this.availability
    if (this.tmuxBinary === null) {
      this.availability = false
      return false
    }
    const binary = this.tmuxBinary
    this.availability = await new Promise<boolean>(resolve => {
      const proc = childSpawn(binary, ['-V'], { stdio: 'ignore' })
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

  /** Absolute path of the tmux binary the registry uses, or null
   *  when no bundled tmux was available at construction. SessionManager
   *  forwards this into TerminalSession so attach-as-child-PTY spawns
   *  the exact same binary the registry used to create the session.
   *  Callers should only invoke this AFTER `isAvailable()` returned
   *  true; the registry's null path is paired with `availability ===
   *  false`, so a non-null return is the practical guarantee here. */
  getBinary(): string | null {
    return this.tmuxBinary
  }

  /** Generate a fresh, unique session name in this registry's namespace. */
  generateName(): string {
    return `${this.namePrefix}${randomUUID()}`
  }

  /** True iff a tmux session with the given name exists. */
  async sessionExists(name: string): Promise<boolean> {
    const binary = this.requireBinary()
    return new Promise(resolve => {
      const proc = childSpawn(
        binary,
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
   * that survived a previous Agent Code run.
   *
   * Returns [] if tmux is unavailable OR if there are no managed
   * sessions — callers shouldn't have to distinguish those cases here
   * (they are different concerns: availability is checked separately
   * at startup, this method just answers "what's alive right now").
   */
  async listManagedSessions(): Promise<Array<{ name: string; createdAt: number }>> {
    // Keep the same "detect first" contract as isAvailable(). Returning [] for
    // the undetected null state hides startup ordering bugs as "no sessions";
    // false after detection still means tmux is unavailable and should be quiet.
    if (!this.isAvailable()) return []

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

  /** Foreground command + cwd for every managed session, from ONE tmux spawn
   *  (#865). Empty when tmux is unavailable or the server has no sessions.
   *
   *  WHY a timeout here but not on listManagedSessions (M1): this call runs
   *  on TerminalForegroundMonitor's 1s poll for every open terminal, so a
   *  single hung `list-panes` (a wedged tmux server, a stuck disk) would
   *  otherwise freeze foreground polling for EVERY terminal indefinitely —
   *  the in-flight guard in terminalForeground.ts prevents pile-up but does
   *  nothing about a poll that never resolves. listManagedSessions only runs
   *  once at launch reconciliation, where hanging is a startup bug worth
   *  surfacing rather than racing against a clock. 2000ms is comfortably
   *  above a healthy `list-panes -a` (a local IPC round trip, not a network
   *  call) and comfortably under making a human notice a stall.
   */
  async listPaneForeground(): Promise<Map<string, TerminalForegroundSample>> {
    if (!this.isAvailable()) return new Map()
    const out = await this.runTmuxCapture(
      ['list-panes', '-a', '-F', PANE_FOREGROUND_FORMAT],
      { timeoutMs: 2000 },
    ).catch(() => '')
    return parsePaneForegroundListing(out, this.namePrefix)
  }

  /** Run a tmux command, resolving with stdout. Reject on non-zero exit or
   *  on timeout (if `timeoutMs` is given — killing the child either way). */
  private runTmuxCapture(args: string[], options: { timeoutMs?: number } = {}): Promise<string> {
    const binary = this.requireBinary()
    return new Promise((resolve, reject) => {
      const proc = childSpawn(binary, args)
      let stdout = ''
      let exitCode: number | null = null
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      // WHY a `settled` latch instead of relying on each handler firing once:
      // a killed process can still emit 'error' AND 'close', and the timeout
      // path calls proc.kill() itself — without the latch the promise could
      // try to settle twice (a no-op for Promise itself, but the intent here
      // is "first settlement wins, the rest are stale signals from a process
      // we've already given up on").
      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        fn()
      }
      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
      proc.on('error', err => settle(() => reject(err)))
      // Only record the exit code here — 'exit' fires as soon as the child
      // process itself terminates, but stdout is a SEPARATE pipe that can
      // still have buffered data in flight at that instant. Resolving here
      // (the old behavior) risked returning truncated stdout for a
      // `list-panes -a` whose output crossed a chunk boundary.
      proc.on('exit', code => { exitCode = code })
      // 'close' fires only after every stdio stream is fully drained, so
      // `stdout` is guaranteed complete by the time this resolves/rejects.
      proc.on('close', () => {
        settle(() => {
          if (exitCode === 0) resolve(stdout)
          else reject(new Error(`tmux ${args.join(' ')} exited ${exitCode}`))
        })
      })
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          proc.kill()
          settle(() => reject(new Error(`tmux ${args.join(' ')} timed out after ${options.timeoutMs}ms`)))
        }, options.timeoutMs)
        // Never let a pending tmux poll keep the app alive at quit — same
        // discipline as the foreground monitor's own interval.unref().
        timer.unref?.()
      }
    })
  }

  /** Run a tmux command, resolving once it exits 0; reject on non-zero. */
  private runTmux(args: string[]): Promise<void> {
    const binary = this.requireBinary()
    return new Promise((resolve, reject) => {
      const proc = childSpawn(binary, args, { stdio: 'ignore' })
      proc.on('error', reject)
      proc.on('exit', code => {
        if (code === 0) resolve()
        else reject(new Error(`tmux ${args.join(' ')} exited ${code}`))
      })
    })
  }

  private requireBinary(): string {
    if (this.tmuxBinary === null) {
      throw new Error('TmuxRegistry: bundled tmux binary is unavailable')
    }
    return this.tmuxBinary
  }
}
