// Reap tmux sessions whose terminal pane is gone for good, WHILE THE APP RUNS.
//
// ── THE LEAK (#1030 item 4) ──
// Closing a tmux-backed terminal stops its attach-PTY and deliberately leaves
// the tmux session alive, so Undo Close can re-attach the same shell with its
// scrollback intact. Nothing ever killed it afterwards: `TmuxRegistry.killSession`
// had exactly two callers — failed-spawn rollback, and `reconcileWorkspace` at
// STARTUP. So every terminal a user closed kept an idle shell (and whatever it
// was running) alive until the next launch. On a machine that stays awake for
// days, with a workflow that opens and closes terminals freely, that is a real
// pile of processes. The unified stage made it worse rather than causing it:
// boot now hibernates every lane but the focused one, so there are more
// terminals whose close main never even observes as a session stop.
//
// ── WHY A SWEEP AND NOT A KILL AT CLOSE TIME ──
// Close is not the moment the shell becomes unreachable — the undo entry is.
// Killing at close would break Undo Close for terminals, which is the entire
// reason the session is left running (#671: losing the scrollback is the bug).
//
// ── WHY THE RENDERER IS NOT ASKED ──
// The obvious alternative is for the renderer to tell main "this tmuxName is
// detached" on close, and to cancel on undo. That cannot cover a HIBERNATED
// terminal — the pane has no live session either side of the close, and main
// hears nothing. It also puts a durable reaping decision behind a message that
// a crashed or reloaded renderer simply never sends. So this asks the two
// authorities that are always right instead: the persisted workspace file
// (which terminals still exist) and main's own registry (which are live right
// now, including ones autosave has not written yet).
//
// ── THE AUTHORITY RULE, INHERITED FROM STARTUP RECOVERY ──
// The `agentcode-` prefix proves a session is OURS, never that it is abandoned.
// Only a COMPLETE workspace inventory can supply the second fact, so an
// unreadable or partially-decoded file withholds cleanup entirely, exactly as
// `reconcileWorkspace` does (#898). A sweep that guessed here would delete a
// terminal whose only reference sat in a region the decoder discarded.
//
// ── WHY THE CLOCK STARTS AT FIRST SIGHTING, NOT AT CLOSE ──
// This holds no close events, so it cannot know when a name became
// unreferenced; it knows when it first OBSERVED that. With a sweep interval
// far shorter than the retention window the error is bounded by one interval
// and always in the safe direction (reaping later than necessary). Restoring a
// terminal through Undo Close puts its name back in the workspace file and in
// main's registry, which clears the timer — a later close starts a fresh one.
//
// The map is in-memory on purpose. Across a restart the undo stack is gone too
// (it is deliberately not persisted), so startup reconcile is free to kill an
// unreferenced session immediately; nothing needs to survive the process.

import { UNDO_CLOSE_RETENTION_MS } from '@shared/undoRetention.js'

import { terminalInventoryFromWorkspaceText } from '@main/tmux/tmuxRecovery.js'

/** The slice of TmuxRegistry a sweep needs; see tmuxRecovery's RecoveryRegistry. */
export type SweepRegistry = {
  isAvailable: () => boolean
  listManagedSessions: () => Promise<Array<{ name: string; createdAt: number }>>
  killSession: (name: string) => Promise<void>
}

export type DetachedSweepReport = {
  /** Names killed by THIS run. */
  reaped: string[]
  /** Alive, unreferenced, still inside the retention window. */
  pending: string[]
  /** Why cleanup was withheld, when it was. Absent on a normal run. */
  withheld?: 'tmux-unavailable' | 'inventory-incomplete' | 'stopped'
}

/**
 * Grace added on top of the undo window before a shell is reaped.
 *
 * The undo entry expires at exactly UNDO_CLOSE_RETENTION_MS, and the renderer
 * prunes LAZILY — on push/pop/peek/length — so an entry can still be sitting
 * in the stack, restorable the instant the user presses ⌘⇧T, a few moments
 * after its nominal expiry. Reaping on the same edge would turn that into a
 * restore onto a dead shell. Five minutes is far longer than any such lag and
 * irrelevant against a one-hour window.
 */
export const DETACHED_REAP_GRACE_MS = 5 * 60 * 1000

export type DetachedSweepOptions = {
  registry: SweepRegistry
  /** The persisted workspace file's text — the same reader startup uses. */
  readWorkspace: () => Promise<string>
  /** tmux names main currently owns. Covers terminals autosave has not written yet. */
  liveTmuxNames: () => Iterable<string>
  now?: () => number
  retentionMs?: number
}

export class DetachedTerminalSweep {
  /** name → when this sweep FIRST saw it alive with no reference anywhere. */
  private firstUnreferencedAt = new Map<string, number>()

  /**
   * Names main bound to a live terminal at ANY point since the current run
   * began reading its evidence.
   *
   * WHY a second structure instead of trusting the authorities (review
   * finding 2): every authority this reads is a snapshot taken before an
   * `await`. `listManagedSessions()` spawns a tmux process, the workspace read
   * hits the disk, and an Undo Close restore can land in either gap — after
   * which the snapshot says "nobody owns this" about a terminal the user is
   * looking at. `noteAttached` is called SYNCHRONOUSLY by SessionManager the
   * instant a tmux session is bound to a registry entry, so a name that
   * appears here after a scan started is disqualified from that scan's kills
   * with no race left: the check and the kill have no await between them.
   */
  private attachedDuringScan = new Set<string>()

  /**
   * Set by `stop()`. A cleared interval does not stop a run already awaiting
   * tmux (review finding 3), and quit is exactly when a kill must not happen:
   * those shells are what the NEXT launch recovers terminals from.
   */
  private stopped = false

  private readonly now: () => number
  private readonly retentionMs: number

  constructor(private readonly options: DetachedSweepOptions) {
    this.now = options.now ?? Date.now
    this.retentionMs = options.retentionMs ?? UNDO_CLOSE_RETENTION_MS + DETACHED_REAP_GRACE_MS
  }

  /**
   * Main bound `tmuxName` to a live terminal.
   *
   * Clearing the timer here rather than at the next sweep is what makes
   * close → undo → close survive (review finding 1): with the timer only ever
   * reset by an observing sweep, an undo at minute 55 and a second close at
   * minute 56 left the ORIGINAL deadline standing, so the shell died at minute
   * 65 while its new undo entry stayed valid until minute 116 — and the undo
   * silently produced a fresh shell with none of the original processes or
   * scrollback.
   */
  noteAttached(tmuxName: string): void {
    this.firstUnreferencedAt.delete(tmuxName)
    this.attachedDuringScan.add(tmuxName)
  }

  /** Permanently disarm. Any run already in flight stops before its next kill. */
  stop(): void {
    this.stopped = true
  }

  /**
   * Both authorities as one set, or null when the workspace file cannot be
   * vouched for. Re-read immediately before the kill phase, because
   * everything computed from the first read happened across awaits.
   */
  private async readReferences(): Promise<Set<string> | null> {
    let text: string
    try {
      text = await this.options.readWorkspace()
    } catch {
      return null
    }
    const inventory = terminalInventoryFromWorkspaceText(text)
    // Same rule as startup: an inventory we cannot vouch for authorizes
    // nothing (#898). Deliberately NOT clearing the timers — the next
    // readable sweep should not have to start the clock over because one
    // autosave was caught mid-write.
    if (inventory.kind !== 'complete') return null
    const referenced = new Set<string>(inventory.references.map(reference => reference.tmuxName))
    for (const name of this.options.liveTmuxNames()) referenced.add(name)
    return referenced
  }

  async run(): Promise<DetachedSweepReport> {
    const { registry } = this.options
    if (this.stopped) return { reaped: [], pending: [], withheld: 'stopped' }
    // The window opens here: anything main attaches from now until this run's
    // last kill is off limits, however stale the snapshots below turn out.
    this.attachedDuringScan.clear()

    if (!registry.isAvailable()) {
      // Not evidence about any session: forget nothing, kill nothing.
      return { reaped: [], pending: [], withheld: 'tmux-unavailable' }
    }

    const referenced = await this.readReferences()
    if (!referenced) return { reaped: [], pending: [], withheld: 'inventory-incomplete' }

    const alive = await registry.listManagedSessions()
    const aliveNames = new Set(alive.map(session => session.name))
    const now = this.now()
    const pending: string[] = []
    const due: string[] = []

    for (const name of aliveNames) {
      if (referenced.has(name)) {
        // In use — an Undo Close restore, or autosave catching up with a
        // terminal that was live all along. Its clock restarts if it is ever
        // unreferenced again.
        this.firstUnreferencedAt.delete(name)
        continue
      }
      const since = this.firstUnreferencedAt.get(name)
      if (since === undefined) {
        this.firstUnreferencedAt.set(name, now)
        pending.push(name)
        continue
      }
      if (now - since < this.retentionMs) {
        pending.push(name)
        continue
      }
      due.push(name)
    }

    // A name that is no longer alive was killed by something else (a user
    // typing `exit`, startup recovery, tmux itself). Holding its timestamp
    // would make a RECYCLED name look overdue the moment it appeared.
    for (const name of [...this.firstUnreferencedAt.keys()]) {
      if (!aliveNames.has(name)) this.firstUnreferencedAt.delete(name)
    }

    if (due.length === 0) return { reaped: [], pending }

    // A kill is imminent, so pay for fresh evidence. `referenced` above was
    // read before the tmux listing, which spawns a process; on a loaded
    // machine that gap is long enough for a user to press ⌘⇧T.
    const confirmed = await this.readReferences()
    if (!confirmed) return { reaped: [], pending: [...pending, ...due], withheld: 'inventory-incomplete' }

    const reaped: string[] = []
    for (const name of due) {
      // Re-checked per name: each kill awaits, and the next name's evidence
      // must be as fresh as the first one's was.
      if (this.stopped) {
        pending.push(name)
        continue
      }
      if (confirmed.has(name) || this.attachedDuringScan.has(name)) {
        this.firstUnreferencedAt.delete(name)
        pending.push(name)
        continue
      }
      // kill first, forget second: a kill that throws keeps its timer, so the
      // next sweep retries instead of restarting the whole window.
      await registry.killSession(name)
      this.firstUnreferencedAt.delete(name)
      reaped.push(name)
    }

    return { reaped, pending }
  }
}

/**
 * How often the sweep looks. Bounds how late a reap can be (one interval on
 * top of the retention window) and is the whole cost of the feature: one
 * `tmux list-sessions` and one workspace-file read every five minutes.
 */
export const DETACHED_SWEEP_INTERVAL_MS = 5 * 60 * 1000

export type DetachedSweepSchedule = {
  /** Disarm permanently, including any run already in flight. */
  stop: () => void
  /** Main bound this tmux name to a live terminal; see DetachedTerminalSweep.noteAttached. */
  noteAttached: (tmuxName: string) => void
}

/**
 * Run the sweep on a timer until stopped.
 *
 * WHY there is no immediate first run: startup reconciliation has just
 * finished, and it already killed everything unreferenced (with no retention,
 * because the undo stack does not survive a restart). A sweep firing seconds
 * later could only re-examine what that pass already judged, and the names it
 * would newly see are terminals THIS run has not even created yet.
 *
 * A throwing sweep is logged by the caller's `onError` and the timer keeps
 * going: the tmux binary being momentarily unavailable, or one kill failing,
 * must not silently end cleanup for the rest of the app's life. Overlap is
 * prevented by an in-flight flag rather than by chaining timeouts, so a hung
 * `tmux list-sessions` cannot queue a backlog of sweeps behind it.
 */
export function startDetachedTerminalSweep(
  options: DetachedSweepOptions & {
    intervalMs?: number
    onSweep?: (report: DetachedSweepReport) => void
    onError?: (error: unknown) => void
  },
): DetachedSweepSchedule {
  const sweep = new DetachedTerminalSweep(options)
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    void sweep
      .run()
      .then(report => options.onSweep?.(report))
      .catch(error => options.onError?.(error))
      .finally(() => { running = false })
  }, options.intervalMs ?? DETACHED_SWEEP_INTERVAL_MS)
  // Reaping idle shells is never a reason to hold the process open.
  timer.unref?.()
  return {
    // `sweep.stop()` is the half that matters: clearing the interval leaves a
    // run already awaiting tmux free to kill afterwards, and quit is precisely
    // when it must not (review finding 3).
    stop: () => { sweep.stop(); clearInterval(timer) },
    noteAttached: name => { sweep.noteAttached(name) },
  }
}
