import type {
  TerminalForegroundSample,
  TerminalForegroundState,
} from '@shared/types/terminalForeground.js'

// TerminalForegroundMonitor — the one producer of plain-shell activity (#865).
//
// WHY the foreground process and not PTY output recency: a shell prompt redraw,
// a clock in the prompt or a TUI's cursor blink all produce output without any
// work happening, and a silent `sleep 600` produces none while very much
// running. The OS already answers the question we mean ("does something other
// than the shell own this terminal?"): tmux reports it as
// `pane_current_command`, and node-pty reports it as `pty.process`.
//
// WHY one poller for all terminals: tmux answers for every managed session in a
// single `list-panes -a` spawn, so the cost is one short-lived process per second
// however many shells are open, and zero when none are.

/** Login shells appear as `-zsh`; the leading dash is stripped before lookup. */
export const SHELL_COMMANDS: ReadonlySet<string> = new Set([
  'bash', 'zsh', 'sh', 'dash', 'fish', 'ksh', 'mksh', 'tcsh', 'csh', 'nu', 'elvish', 'xonsh', 'pwsh', 'login',
])

const DEFAULT_INTERVAL_MS = 1000

export type TerminalForegroundSource =
  | { kind: 'tmux'; tmuxName: string }
  | { kind: 'direct' }

export function normalizeForegroundCommand(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const base = trimmed.split('/').pop() ?? trimmed
  const bare = base.startsWith('-') ? base.slice(1) : base
  return bare || null
}

export function classifyForeground(sample: TerminalForegroundSample): TerminalForegroundState {
  const command = normalizeForegroundCommand(sample.command)
  const cwd = typeof sample.cwd === 'string' && sample.cwd.length > 0 ? sample.cwd : null
  // Unknown (null) is idle on purpose: a lit header is a claim, and "the
  // backend could not tell us" is not evidence of work.
  return { busy: command !== null && !SHELL_COMMANDS.has(command), command, cwd }
}

function sameForeground(a: TerminalForegroundState | undefined, b: TerminalForegroundState): boolean {
  return a !== undefined && a.busy === b.busy && a.command === b.command && a.cwd === b.cwd
}

export type TerminalForegroundMonitorDeps = {
  /** Every managed tmux session's foreground, keyed by tmux session name. */
  listTmuxPanes: () => Promise<ReadonlyMap<string, TerminalForegroundSample>>
  /** Direct-PTY foreground for one session, or null when it cannot be read. */
  sampleDirect: (sessionId: string) => TerminalForegroundSample | null
  onChange: (sessionId: string, state: TerminalForegroundState) => void
  intervalMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export class TerminalForegroundMonitor {
  private readonly sources = new Map<string, TerminalForegroundSource>()
  private readonly last = new Map<string, TerminalForegroundState>()
  private readonly intervalMs: number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private timer: unknown = null
  private inFlight = false
  private disposed = false

  constructor(private readonly deps: TerminalForegroundMonitorDeps) {
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
    this.setTimer = deps.setTimer ?? ((fn, ms) => {
      const handle = setInterval(fn, ms)
      // The poller must never be the thing keeping main alive at quit.
      handle.unref?.()
      return handle
    })
    this.clearTimer = deps.clearTimer ?? (handle => clearInterval(handle as ReturnType<typeof setInterval>))
  }

  track(sessionId: string, source: TerminalForegroundSource): void {
    if (this.disposed) return
    this.sources.set(sessionId, source)
    if (this.timer === null) this.timer = this.setTimer(() => { void this.tick() }, this.intervalMs)
  }

  untrack(sessionId: string): void {
    this.sources.delete(sessionId)
    // Forgetting is what lets a recovered session under the same id report its
    // first sample again instead of being deduped against a dead predecessor.
    this.last.delete(sessionId)
    if (this.sources.size === 0) this.stopTimer()
  }

  snapshot(): Record<string, TerminalForegroundState> {
    return Object.fromEntries(this.last)
  }

  /** One poll. Public for tests; production calls it from the interval. */
  async tick(): Promise<void> {
    // WHY the in-flight guard is load-bearing: the 2026-07-07 OOM was a 200 ms
    // poll with no guard whose reads piled up behind a slow filesystem. A tmux
    // server that stalls must cost one pending tick, not one per second forever.
    if (this.inFlight || this.disposed || this.sources.size === 0) return
    this.inFlight = true
    try {
      const needsTmux = [...this.sources.values()].some(source => source.kind === 'tmux')
      const panes = needsTmux ? await this.deps.listTmuxPanes().catch(() => null) : null
      if (this.disposed) return
      // Iterates the live map after the await, so a session untracked while
      // tmux answered is simply absent here and never resurrected.
      for (const [sessionId, source] of this.sources) {
        const sample = source.kind === 'tmux'
          ? panes?.get(source.tmuxName) ?? null
          : this.deps.sampleDirect(sessionId)
        // No sample means "unknown this tick" (tmux hiccup, PTY mid-exit). Keep
        // the last answer rather than flapping the header idle and back.
        if (!sample) continue
        const next = classifyForeground(sample)
        if (sameForeground(this.last.get(sessionId), next)) continue
        this.last.set(sessionId, next)
        this.deps.onChange(sessionId, next)
      }
    } finally {
      this.inFlight = false
    }
  }

  dispose(): void {
    this.disposed = true
    this.stopTimer()
    this.sources.clear()
    this.last.clear()
  }

  private stopTimer(): void {
    if (this.timer === null) return
    this.clearTimer(this.timer)
    this.timer = null
  }
}
