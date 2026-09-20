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
  withheld?: 'tmux-unavailable' | 'inventory-incomplete'
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

  private readonly now: () => number
  private readonly retentionMs: number

  constructor(private readonly options: DetachedSweepOptions) {
    this.now = options.now ?? Date.now
    this.retentionMs = options.retentionMs ?? UNDO_CLOSE_RETENTION_MS + DETACHED_REAP_GRACE_MS
  }

  async run(): Promise<DetachedSweepReport> {
    const { registry, readWorkspace, liveTmuxNames } = this.options
    if (!registry.isAvailable()) {
      // Not evidence about any session: forget nothing, kill nothing.
      return { reaped: [], pending: [], withheld: 'tmux-unavailable' }
    }

    let text: string
    try {
      text = await readWorkspace()
    } catch {
      return { reaped: [], pending: [], withheld: 'inventory-incomplete' }
    }
    const inventory = terminalInventoryFromWorkspaceText(text)
    if (inventory.kind !== 'complete') {
      // Same rule as startup: an inventory we cannot vouch for authorizes
      // nothing. Deliberately NOT clearing the timers — the next readable
      // sweep should not have to start the clock over because one autosave
      // was caught mid-write.
      return { reaped: [], pending: [], withheld: 'inventory-incomplete' }
    }

    const referenced = new Set<string>(inventory.references.map(reference => reference.tmuxName))
    for (const name of liveTmuxNames()) referenced.add(name)

    const alive = await registry.listManagedSessions()
    const aliveNames = new Set(alive.map(session => session.name))
    const now = this.now()
    const reaped: string[] = []
    const pending: string[] = []

    for (const name of aliveNames) {
      if (referenced.has(name)) {
        // Back in use — an Undo Close restore, or autosave catching up with a
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
      // kill first, forget second: a kill that throws keeps its timer, so the
      // next sweep retries instead of restarting the whole window.
      await registry.killSession(name)
      this.firstUnreferencedAt.delete(name)
      reaped.push(name)
    }

    // A name that is no longer alive was killed by something else (a user
    // typing `exit`, startup recovery, tmux itself). Holding its timestamp
    // would make a RECYCLED name look overdue the moment it appeared.
    for (const name of [...this.firstUnreferencedAt.keys()]) {
      if (!aliveNames.has(name)) this.firstUnreferencedAt.delete(name)
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

export type DetachedSweepSchedule = { stop: () => void }

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
  return { stop: () => clearInterval(timer) }
}
