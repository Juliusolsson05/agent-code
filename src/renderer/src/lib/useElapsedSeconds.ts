import { useEffect, useState } from 'react'

/**
 * Seconds elapsed since `since`, ticking at 1 Hz. `null` in, `null` out.
 *
 * Extracted from `WorkIndicator`, which owned the only copy until the pane
 * readiness line needed the identical behaviour. Two copies of a ticking hook
 * is how one of them quietly drifts to a different interval and the UI starts
 * disagreeing with itself about how long something has been happening.
 *
 * WHY 1 Hz and not requestAnimationFrame or 100ms: this answers "how long have
 * I been waiting", where sub-second precision changes no decision, and every
 * tick re-renders a subtree that can contain hundreds of already-mounted feed
 * rows. The re-render cost is real and the extra precision is worth nothing.
 *
 * WHY no timer at all when `since` is null: a workspace of healthy panes must
 * not hold a bank of intervals for status lines that are not being shown.
 */
export function useElapsedSeconds(since: number | null): number | null {
  const [elapsed, setElapsed] = useState<number | null>(() =>
    since === null ? null : Math.max(0, Math.floor((Date.now() - since) / 1000)),
  )
  useEffect(() => {
    if (since === null) {
      setElapsed(null)
      return
    }
    // Fire once immediately so the switch from null → number isn't a full
    // second behind; then tick at 1 Hz.
    const tick = (): void => setElapsed(Math.max(0, Math.floor((Date.now() - since) / 1000)))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [since])
  return elapsed
}
