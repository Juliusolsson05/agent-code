// When the machine was not running (#963, docs/decomposition/agent-working-time.md
// Stage 2).
//
// WHY a shared contract instead of each consumer asking Electron itself: three
// consumers need the same fact — the in-feed turn clock (so a turn does not count
// the night as Thinking), the provider adapters (so a stream the sleep severed can
// be sealed) and the working-time recorder (so analytics never counts sleep). If
// each derived sleep on its own, they would disagree about the same laptop lid
// closing, which is exactly the two-truths failure the decomposition exists to
// prevent. Main owns detection; everything else consumes these intervals.

export type SystemSuspensionSource =
  /** Electron `powerMonitor` reported suspend and/or resume. */
  | 'power-monitor'
  /** Main's own timer stopped firing for far longer than its interval AND the OS
   *  reports a wake inside that gap. Covers a sleep whose power events were
   *  missed; a main-thread stall has no OS wake and is never reported. */
  | 'tick-gap'

export type SystemSuspension = {
  /** Wall-clock ms when the machine stopped running (best evidence). */
  suspendedAt: number
  /** Wall-clock ms when it ran again. Always greater than `suspendedAt`. */
  resumedAt: number
  source: SystemSuspensionSource
}

/** main → every application window, once per detected suspension. */
export const SYSTEM_SUSPENSION_CHANNEL = 'system:suspension'
/** renderer → main: the recent suspensions, oldest first. A window that loads
 *  after a wake still needs to know the machine slept during a live turn. */
export const SYSTEM_SUSPENSIONS_READ_CHANNEL = 'system:suspensions'
