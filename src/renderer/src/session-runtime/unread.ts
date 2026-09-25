import type { SessionRuntime } from './state'

/**
 * Mark a runtime unread.
 *
 * Unread is an acknowledgement marker, not a focus marker.
 * Dispatch navigation, tab restore, and automatic focus sync can all
 * make a session "focused" without the user reading or acting on it.
 * Writers therefore mark only meaningful milestones unread: ordinary
 * output waits until the agent turn finishes, while attention prompts
 * still surface immediately. Explicit engagement handlers (composer
 * edit/click/paste, feed scroll/click, terminal click/input, action
 * sends) clear it via acknowledgeSession().
 * The one non-engagement clear is dwell (#1172): a pane that stays focused
 * AND visible for SEEN_DWELL_MS (useAcknowledgeAfterDwell) counts as seen.
 * That doesn't contradict the rule above. Arrow-key sweeps, Dispatch
 * selection and focus sync move focus for a few hundred ms at most, and a
 * pane that holds focus on screen for seconds really was looked at. The
 * same marker drives both the Dispatch NEW badge and the pane header's
 * completion stripes, so the two always agree.
 * Attention outranks ordinary output: once a permission/trust
 * prompt appears, the list should keep showing ACTION until
 * the user opens that agent or the prompt resolves. A later
 * transcript append must not downgrade the marker to NEW.
 *
 * WHY this is a module now (#865): terminal foreground changes arrive through
 * their own subscription hook and must mark "command finished" exactly the way
 * an agent's turn completion does. Two copies of "attention outranks output"
 * is how a list badge and a pane come to disagree.
 */
export function withUnread(
  runtime: SessionRuntime,
  kind: 'output' | 'attention',
  now: number = Date.now(),
): SessionRuntime {
  const unreadKind =
    runtime.unreadKind === 'attention' || kind === 'attention'
      ? 'attention'
      : 'output'
  return {
    ...runtime,
    unreadSince: runtime.unreadSince ?? now,
    unreadKind,
  }
}
