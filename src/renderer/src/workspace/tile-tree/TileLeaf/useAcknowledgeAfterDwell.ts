import { useLayoutEffect, useRef } from 'react'

/**
 * How long a pane must stay focused AND visible before its unread marker
 * counts as seen (#1172).
 *
 * WHY 1.5 s: the workspace is driven with arrow keys, and one hop across a
 * pane takes roughly 100–300 ms, so a sweep across the grid stays well under
 * this. Stopping to read even a one-line answer takes longer. Much shorter and
 * a slow sweep clears panes the user never looked at. Much longer and a user
 * who read the answer and moved on finds it still flagged. If this is ever
 * tuned, keep it clearly above a deliberate key-repeat hop.
 */
export const SEEN_DWELL_MS = 1500

/**
 * Acknowledge a pane's unread marker once the user has stayed on it long
 * enough to have seen it.
 *
 * WHY dwell and not focus: focus is not a read signal here. Arrow-key
 * navigation, Dispatch selection, tab restore and focus sync all move focus
 * without the user reading anything (see session-runtime/unread.ts). Clearing
 * on focus would wipe the completion stripes of every pane the user merely
 * passed through. Engagement (typing, clicking, scrolling) still clears
 * instantly through the callers' existing acknowledgeSession wiring. This hook
 * adds only the "stopped and looked" case.
 *
 * `active` must mean focused AND visible (useInteractiveOwnership's
 * `interactive`). A focused pane retained under display:none behind Reader
 * Mode, Settings or the fullscreen editor is not being looked at.
 *
 * WHY the dwell is measured from when the pane became active, not from when
 * the marker appeared: a pane the user is already watching when its turn ends
 * should never flash the indicator. Its active-since is old, the remaining
 * dwell is ≤ 0, and it acknowledges straight away. That happens in a LAYOUT
 * effect, so the store update lands before the browser paints the stripes.
 * Anchoring to active-since also makes re-arming harmless. A streaming pane
 * re-renders constantly, and every re-run of the timer effect recomputes
 * the same deadline instead of pushing it back.
 */
export function useAcknowledgeAfterDwell(
  active: boolean,
  unread: boolean,
  acknowledge: () => void,
): void {
  const activeSinceRef = useRef<number | null>(null)

  // Declared before the timer effect on purpose: React runs layout effects in
  // declaration order, so the timer below always reads this commit's
  // active-since, never the previous one.
  useLayoutEffect(() => {
    if (!active) activeSinceRef.current = null
    else if (activeSinceRef.current === null) activeSinceRef.current = Date.now()
  }, [active])

  useLayoutEffect(() => {
    if (!active || !unread) return
    const since = activeSinceRef.current ?? Date.now()
    const remaining = SEEN_DWELL_MS - (Date.now() - since)
    if (remaining <= 0) {
      acknowledge()
      return
    }
    const timer = setTimeout(acknowledge, remaining)
    return () => clearTimeout(timer)
  }, [active, unread, acknowledge])
}
