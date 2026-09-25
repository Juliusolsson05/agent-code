import { useLayoutEffect, useRef } from 'react'

import { useGoalLoopView } from '@renderer/features/goal-loop/viewState'
import { useTldrView } from '@renderer/features/tldr/viewState'
import { useWindowFocused } from '@renderer/lib/useWindowFocused'
import { useAgentTerminalOwnerVisible } from '@renderer/workspace/terminal/AgentTerminalOwnership'

/**
 * How long a pane must stay watched before its unread marker counts as seen
 * (#1172).
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
 * Acknowledge a pane's unread marker once the user has watched it long enough
 * to have seen it.
 *
 * WHY dwell and not focus: focus is not a read signal here. Arrow-key
 * navigation, Dispatch selection, tab restore and focus sync all move focus
 * without the user reading anything (see session-runtime/unread.ts). Clearing
 * on focus would wipe the completion outline of every pane the user merely
 * passed through. Engagement (typing, clicking, scrolling) still clears
 * instantly through the callers' existing acknowledgeSession wiring. This hook
 * adds only the "stopped and looked" case.
 *
 * WHY the hook decides "watched" itself instead of taking an `active` flag:
 * every part of it is easy to get wrong at a call site, and the first version
 * got three of them wrong (PR #1176 review). A pane is watched only when ALL
 * of these hold:
 *   - it is the focused pane (`focused`, the caller's layout-specific answer);
 *   - no hiding shell covers it: Reader/Spotlight/Settings or the fullscreen
 *     editor keep the workspace mounted under display:none, which is the same
 *     visibility context useInteractiveOwnership reads;
 *   - the app window is in front (useWindowFocused). Otherwise an agent
 *     finishing while the user is in their browser would be "seen";
 *   - no TLDR/Goal/Goal Loop peek is up. Those opaque overlays cover the
 *     panes, and while one is up the user is reading the overlay.
 *
 * WHY the dwell is measured from when the pane became watched, not from when
 * the marker appeared: a pane the user is already watching when its turn ends
 * should never flash the indicator. Its watched-since is old, the remaining
 * dwell is ≤ 0, and it acknowledges straight away. That happens in a LAYOUT
 * effect, so the store update lands before the browser paints the outline.
 * Anchoring to watched-since also makes re-arming harmless. A streaming pane
 * re-renders constantly, and every re-run of the timer effect recomputes the
 * same deadline instead of pushing it back.
 *
 * WHY watched-since is tied to `sessionId`: a lane in Tiled Dispatch, and
 * Spotlight's leaf, are reused for a different agent without remounting and
 * stay focused throughout. If the time the user spent watching agent A counted
 * toward agent B, arrowing onto an unread B would clear it at once.
 *
 * Known limit: Hybrid view swaps a pane between the feed and terminal
 * surfaces by remounting it, which restarts its dwell. The worst case is that
 * a watched pane needs one more 1.5 s to clear, never that an unseen one
 * clears early.
 */
export function useAcknowledgeAfterDwell({
  sessionId,
  focused,
  unread,
  acknowledge,
}: {
  sessionId: string
  focused: boolean
  unread: boolean
  acknowledge: () => void
}): void {
  const ownerVisible = useAgentTerminalOwnerVisible()
  const windowFocused = useWindowFocused()
  const tldrPeekUp = useTldrView(state => state.held || state.latched)
  const goalLoopPeekUp = useGoalLoopView(state => state.latched)
  const watching = focused && ownerVisible && windowFocused && !tldrPeekUp && !goalLoopPeekUp

  const watchedSinceRef = useRef<{ sessionId: string; at: number } | null>(null)

  // Declared before the timer effect on purpose: React runs layout effects in
  // declaration order, so the timer below always reads this commit's
  // watched-since, never the previous one.
  useLayoutEffect(() => {
    if (!watching) watchedSinceRef.current = null
    else if (watchedSinceRef.current?.sessionId !== sessionId) {
      watchedSinceRef.current = { sessionId, at: Date.now() }
    }
  }, [watching, sessionId])

  useLayoutEffect(() => {
    if (!watching || !unread) return
    const since = watchedSinceRef.current?.at ?? Date.now()
    const remaining = SEEN_DWELL_MS - (Date.now() - since)
    if (remaining <= 0) {
      acknowledge()
      return
    }
    const timer = setTimeout(acknowledge, remaining)
    return () => clearTimeout(timer)
  }, [watching, unread, sessionId, acknowledge])
}
