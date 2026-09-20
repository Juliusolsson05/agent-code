import { useEffect } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { commandTargetSessionIdForState } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import {
  clearDictationFocusedSession,
  setDictationFocusedSession,
} from '@renderer/workspace/tile-tree/TileLeaf/dictationHotkeyRegistry'

/**
 * Tell the dictation registry which agent the user is actually commanding
 * (#1031 item 3).
 *
 * ── THE BUG THIS CLOSES ──
 * With no DOM-focused input, the registry picked the most RECENTLY focused
 * dictation target anywhere in the workspace. Clear Lane (⌥⌫) makes that
 * trivially reachable: clear the lane you are looking at, hold Fn, speak — and
 * the words land in a different lane's composer, which may then send them. The
 * same crossing happens any time the focused lane's occupant has no DOM focus
 * but you last typed somewhere else.
 *
 * ── WHY `commandTargetSessionIdForState` AND NOT THE LANE DIRECTLY ──
 * It is the file that already answers "which session is the user currently
 * commanding?", and it answers it including the focus TAKEOVERS: with Spotlight
 * or Reader open, the only agent on screen is that one, and dictation must
 * follow it for the same reason Stop Goal Loop and Close Focused Session do.
 * Reading `stage.lanes[focusedLane]` here instead would be the exact mistake
 * that file documents (#266/#267/#271/#272 were all that mistake).
 *
 * ── WHY THIS IS APP-LEVEL AND NOT PER PANE ──
 * A pane can only report itself. The fact that matters — "the focused lane is
 * EMPTY" — is the absence of a pane, so no pane can report it. It is published
 * once, from the place that already owns app-wide dictation wiring.
 */
export function useDictationFocusedSession(): void {
  const focusedSessionId = useAppStore(state => commandTargetSessionIdForState(state.workspaceState))

  useEffect(() => {
    setDictationFocusedSession(focusedSessionId)
  }, [focusedSessionId])

  useEffect(() => () => {
    // On unmount the workspace is gone, so no answer is better than a stale
    // one: this restores the "nobody has told us yet" state, which is the one
    // that keeps the launch fallback.
    clearDictationFocusedSession()
  }, [])
}
