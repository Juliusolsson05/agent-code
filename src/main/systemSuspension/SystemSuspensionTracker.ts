import { EventEmitter } from 'node:events'

import type { SystemSuspension } from '@shared/types/systemSuspension.js'

// The one owner of "the machine was not running" (#963, decomposition Stage 2).
//
// Events:
//   'suspend'    — Electron reported suspend. Power-monitor evidence only.
//   'resume'     — Electron reported resume. Power-monitor evidence only.
//   'suspension' — (SystemSuspension) one closed interval, from either source,
//                  never overlapping an interval already published.
//
// WHY 'suspend'/'resume' are power-monitor ONLY: MainProbe uses them to suppress
// event-loop and CPU readings across a sleep, and its own comment is explicit that
// "a long callback gap is also exactly what an awake main-thread stall looks like.
// Only Electron suspend/resume evidence may suppress it." Feeding it tick-gap
// evidence would hide real stalls from the performance monitor.
//
// WHY a tick-gap fallback exists at all: nothing on record shows `powerMonitor`
// firing reliably for every kind of macOS sleep (clamshell, battery, dark wake) —
// the performance monitor's `sleepGap` has never been observed true, and no sleep
// happened in the run that shipped it. A missed resume would leave every consumer
// believing the machine never slept, which is the bug itself. Timers do not run
// while the machine sleeps, so a tick that arrives far later than its interval is
// the process's own evidence of having been frozen.
//
// WHY that evidence must be confirmed by the OS: a main-thread stall produces the
// identical gap, and provider CLIs run in separate processes that keep working
// during a main stall. Treating a stall as sleep would subtract real working time
// and could seal a live stream. Clock drift cannot tell the two apart either: in
// real recordings `performance.now()` advanced with the wall clock straight
// through a 9-hour clamshell sleep. So a gap is published only when the OS reports
// a wake inside it (`kern.waketime` on macOS). No OS evidence, no suspension.

export type PowerEventSource = {
  on(event: 'suspend' | 'resume', listener: () => void): unknown
  removeListener(event: 'suspend' | 'resume', listener: () => void): unknown
}

export type SystemSuspensionTrackerOptions = {
  power: PowerEventSource
  /** Most recent OS wake as wall-clock ms, or null when the OS cannot say. */
  readLastWakeAt: () => Promise<number | null>
  /** How often main checks its own clock. Coarse on purpose: this runs forever. */
  tickIntervalMs?: number
  /** A tick later than this is a candidate sleep. Far above any healthy tick. */
  gapThresholdMs?: number
  /** Electron's resume usually lands just after the first post-wake tick. Give it
   *  this long to claim the gap, so one sleep is recorded once, from the better
   *  source. */
  resumeGraceMs?: number
  /** Suspensions kept for late readers. Each is three numbers; this is kilobytes. */
  retain?: number
}

const DEFAULT_TICK_INTERVAL_MS = 5_000
const DEFAULT_GAP_THRESHOLD_MS = 60_000
const DEFAULT_RESUME_GRACE_MS = 3_000
const DEFAULT_RETAIN = 200

export class SystemSuspensionTracker extends EventEmitter {
  private readonly power: PowerEventSource
  private readonly readLastWakeAt: () => Promise<number | null>
  private readonly tickIntervalMs: number
  private readonly gapThresholdMs: number
  private readonly resumeGraceMs: number
  private readonly retain: number

  private timer: ReturnType<typeof setInterval> | null = null
  private lastTickAt = Date.now()
  /** Set by a power-monitor suspend; cleared by the matching resume. */
  private suspendedAt: number | null = null
  /** A tick gap waiting for the grace period and OS confirmation. */
  private pendingGap: { from: number; to: number } | null = null
  private readonly history: SystemSuspension[] = []

  constructor(options: SystemSuspensionTrackerOptions) {
    super()
    this.power = options.power
    this.readLastWakeAt = options.readLastWakeAt
    this.tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS
    this.gapThresholdMs = options.gapThresholdMs ?? DEFAULT_GAP_THRESHOLD_MS
    this.resumeGraceMs = options.resumeGraceMs ?? DEFAULT_RESUME_GRACE_MS
    this.retain = options.retain ?? DEFAULT_RETAIN
  }

  start(): void {
    if (this.timer) return
    this.power.on('suspend', this.onSuspend)
    this.power.on('resume', this.onResume)
    this.lastTickAt = Date.now()
    this.timer = setInterval(() => this.tick(), this.tickIntervalMs)
    // Never keep the app alive just to watch the clock.
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
    this.power.removeListener('suspend', this.onSuspend)
    this.power.removeListener('resume', this.onResume)
  }

  /** Recent suspensions, oldest first. */
  list(): SystemSuspension[] {
    return [...this.history]
  }

  private readonly onSuspend = (): void => {
    if (this.suspendedAt !== null) return
    this.suspendedAt = Date.now()
    this.emit('suspend')
  }

  private readonly onResume = (): void => {
    const resumedAt = Date.now()
    // Best start evidence, in order: our own suspend stamp; a gap the first
    // post-wake tick already measured (the suspend event was missed but the tick
    // saw the freeze); the last tick before resume.
    const stamped = this.suspendedAt ?? this.pendingGap?.from ?? null
    const suspendedAt = stamped ?? this.lastTickAt
    this.suspendedAt = null
    // The power monitor claims this sleep; a pending tick-gap for it is dropped.
    this.pendingGap = null
    this.lastTickAt = resumedAt
    // With only the last tick as evidence, a short interval is not a sleep: ticks
    // were running until moments ago. This is the late-resume shape — Electron's
    // resume lands a few seconds after post-wake ticks already recorded the sleep
    // as a tick gap. Publishing it would add a bogus few-second "sleep" right after
    // the real one (a mutation check found the earlier overlap guard never ran on
    // this path). A real sleep with a missed suspend and no tick yet since wake has
    // a last tick from before the lid closed, far beyond the threshold.
    if (stamped === null && resumedAt - suspendedAt <= this.gapThresholdMs) {
      this.emit('resume')
      return
    }
    this.publish({ suspendedAt, resumedAt, source: 'power-monitor' })
    this.emit('resume')
  }

  private tick(): void {
    const now = Date.now()
    const from = this.lastTickAt
    this.lastTickAt = now
    // Between a power-monitor suspend and its resume the resume owns the interval.
    if (this.suspendedAt !== null) return
    if (now - from <= this.gapThresholdMs) return
    const gap = { from, to: now }
    this.pendingGap = gap
    void this.confirmGap(gap)
  }

  private async confirmGap(gap: { from: number; to: number }): Promise<void> {
    await new Promise<void>(resolve => {
      const grace = setTimeout(resolve, this.resumeGraceMs)
      grace.unref?.()
    })
    // A resume arrived during the grace period and recorded this sleep.
    if (this.pendingGap !== gap) return
    this.pendingGap = null
    let wakeAt: number | null
    try {
      wakeAt = await this.readLastWakeAt()
    } catch {
      wakeAt = null
    }
    // No OS wake inside the gap: main was stalled, not asleep. See header.
    if (wakeAt === null || wakeAt <= gap.from || wakeAt > gap.to) return
    this.publish({ suspendedAt: gap.from, resumedAt: gap.to, source: 'tick-gap' })
  }

  private publish(suspension: SystemSuspension): void {
    if (suspension.resumedAt <= suspension.suspendedAt) return
    // One sleep is seen by at most one publication: a power-monitor suspend stamp
    // makes the tick defer to resume, a resume inside the grace period claims the
    // pending gap, and a late resume after a published gap is rejected in
    // onResume. No overlap check is needed here, and the one that used to be here
    // was proven unreachable by a mutation check.
    this.history.push(suspension)
    if (this.history.length > this.retain) this.history.shift()
    this.emit('suspension', suspension)
  }
}
