import type { SystemSuspension } from '@shared/types/systemSuspension.js'

// The one definition of "how long has this turn been working" (#963,
// docs/decomposition/agent-working-time.md Stage 3b).
//
// WHY this exists: the in-feed counter used `Date.now() - turnStartedAt`, so a
// turn that was live when the lid closed read `Thinking · 11h04m` the moment the
// machine woke — the provider's own clock (Claude's `turn_duration`) makes the
// same mistake in real recordings. Working time is wall time minus the time the
// machine was not running. Every surface that shows or records turn time must use
// this function instead of subtracting timestamps itself, or the counter and the
// analytics will disagree about the same night.
//
// WHY `src/shared`: the desktop counter, the phone client and the main-process
// recorder (Stage 4) all need the identical rule, and only shared code reaches all
// three.

type SuspensionSpan = Pick<SystemSuspension, 'suspendedAt' | 'resumedAt'>

/** Milliseconds of suspension inside [from, to]. Suspensions from
 *  SystemSuspensionTracker never overlap, so a plain sum is exact. */
export function suspendedMsWithin(
  suspensions: readonly SuspensionSpan[],
  from: number,
  to: number,
): number {
  let total = 0
  for (const suspension of suspensions) {
    const start = Math.max(suspension.suspendedAt, from)
    const end = Math.min(suspension.resumedAt, to)
    if (end > start) total += end - start
  }
  return total
}

/** Whole seconds a turn has been working at `now`, excluding suspension; null
 *  when no turn clock is running. */
export function workingSeconds(
  turnStartedAt: number | null,
  suspensions: readonly SuspensionSpan[],
  now: number,
): number | null {
  if (turnStartedAt === null) return null
  const workingMs = now - turnStartedAt - suspendedMsWithin(suspensions, turnStartedAt, now)
  return Math.max(0, Math.floor(workingMs / 1000))
}
