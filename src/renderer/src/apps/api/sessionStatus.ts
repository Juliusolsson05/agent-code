import type { AppStore } from '@renderer/app-state/types'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import { dispatchUnreadBadge } from '@renderer/session-runtime/unreadBadge'
import { sessionIsWorking } from '@renderer/session-runtime/working'

import type {
  ExtensionSessionActivity,
  ExtensionSessionNotification,
} from '@renderer/apps/api/types'

/**
 * The two live facts `sessions.observe()` reports per session (#1479).
 *
 * ── ONE RULE, NOT A THIRD ──
 * Both answers are delegated, never re-derived. `sessionIsWorking` is the
 * rule the Dispatch running count, the composer Stop button and agent follow
 * already share; `dispatchUnreadBadge` is the badge Dispatch paints and the
 * completion outline's marker. The first consumer is a card game's agent
 * panel sitting next to Dispatch on the same screen: if it said "working"
 * while Dispatch said idle, the user would trust neither. Any rule change
 * belongs in those two functions, and this projection follows for free.
 *
 * A missing runtime projects as idle with no notification: a session this
 * renderer has not observed is not busy (#880), and an unread marker cannot
 * exist without a runtime to hold it.
 */
export function projectSessionStatus(runtime: SessionRuntime | undefined): {
  activity: ExtensionSessionActivity
  notification: ExtensionSessionNotification | null
} {
  const badge = runtime ? dispatchUnreadBadge(runtime) : null
  return {
    activity: sessionIsWorking(runtime) ? 'working' : 'idle',
    notification: badge ? { kind: badge.kind, label: badge.text } : null,
  }
}

/**
 * A compact string that changes exactly when some session's projected status
 * (or the session set) changes. Used as a zustand SELECTOR, so a store write
 * that leaves the string equal fires no listener.
 *
 * ── WHY NOT SUBSCRIBE TO `workspaceRuntimes` ──
 * The runtime map is replaced on every streamed transcript chunk. A listener
 * on its identity would push a change nudge to every open extension frame many
 * times a second while any agent streams, and each nudge makes the extension
 * re-read every session. The status an extension can see changes a few times
 * per turn; this string is what turns the first rate into the second.
 *
 * Cost: one short string per store write, O(sessions), only while an extension
 * view holding `sessions.observe` is mounted (viewBridge) or a same-realm
 * caller subscribed. `sessionIsWorking`/`dispatchUnreadBadge` are a few field
 * reads each — the condition label walks the provider's attention rules, a
 * handful of entries — so there is nothing worth memoising per runtime.
 *
 * The id is part of each segment so the string is self-sufficient: one session
 * replaced by another in the same tick, with the same status, still changes
 * it. The session-row listener beside it would catch that case too, but a
 * same-realm caller may subscribe to this signature alone.
 */
export function sessionStatusSignature(
  state: Pick<AppStore, 'workspaceState' | 'workspaceRuntimes'>,
): string {
  let signature = ''
  for (const id of Object.keys(state.workspaceState.sessions)) {
    const { activity, notification } = projectSessionStatus(state.workspaceRuntimes[id])
    signature += `${id}:${activity === 'working' ? 'w' : 'i'}:${notification ? `${notification.kind}/${notification.label}` : '-'}\n`
  }
  return signature
}
