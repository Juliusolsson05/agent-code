import { useAppStore } from '@renderer/app-state/hooks'
import { sessionStatusSignature } from '@renderer/apps/api/sessionStatus'

/** The Tier-1 observe capabilities and the nudge topic each one unlocks. */
const OBSERVE_TOPICS = [
  ['workspace.observe', 'workspace'],
  ['sessions.observe', 'sessions'],
  ['panes.observe', 'panes'],
] as const

export type ObserveTopic = (typeof OBSERVE_TOPICS)[number][1]

/** Only granted capabilities get nudges: a nudge carries no data, but it still
 *  tells a frame that something it may not read has changed. */
export function grantedObserveTopics(granted: readonly string[]): ObserveTopic[] {
  return OBSERVE_TOPICS.filter(([capability]) => granted.includes(capability)).map(([, topic]) => topic)
}

/** How long a burst of store writes is coalesced into one nudge per topic. */
export const OBSERVE_NUDGE_MS = 120

/**
 * Wake an extension frame's `<topic>.subscribe` listeners when the data behind
 * a granted topic changes. Returns a dispose that unsubscribes everything and
 * cancels a pending nudge.
 *
 * ── WHY THIS IS ITS OWN MODULE (#1479 review) ──
 * It lived inline in viewBridge's mount effect, where nothing could test it.
 * The review deleted the status subscription and every test stayed green,
 * although that subscription is the ONLY thing that tells a frame an agent
 * finished its turn — the same-realm `createAppHostApi().sessions.subscribe`
 * is never called by a frame (frameDocument's subscribe waits for these
 * pushes). Pulled out, the frame path has a test of its own.
 *
 * Two sources, one timer:
 * - any `workspaceState` write nudges every granted topic (pre-#1479
 *   behaviour; rows, tabs and panes all live there);
 * - a change of the projected session STATUS signature nudges `sessions`
 *   only. Status lives on runtimes, which a workspaceState listener never
 *   sees: an agent finishing its turn changes no session row. The selector is
 *   the signature, not the runtime map, because the map is replaced on every
 *   streamed chunk (see sessionStatusSignature).
 * The pending SET means a workspace burst and a status flip inside one window
 * still produce exactly one push per topic, and the push happens after the
 * window, so the frame's re-read sees the latest state.
 */
export function subscribeObserveNudges(
  topics: readonly ObserveTopic[],
  push: (topic: ObserveTopic) => void,
): () => void {
  if (topics.length === 0) return () => {}
  let timer: ReturnType<typeof setTimeout> | null = null
  const pending = new Set<ObserveTopic>()
  const nudge = (next: readonly ObserveTopic[]) => {
    for (const topic of next) pending.add(topic)
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      const due = [...pending]
      pending.clear()
      for (const topic of due) push(topic)
    }, OBSERVE_NUDGE_MS)
  }
  const offWorkspace = useAppStore.subscribe(state => state.workspaceState, () => nudge(topics))
  const offStatus = topics.includes('sessions')
    ? useAppStore.subscribe(sessionStatusSignature, () => nudge(['sessions']))
    : null
  return () => {
    offWorkspace()
    offStatus?.()
    if (timer !== null) clearTimeout(timer)
    timer = null
    pending.clear()
  }
}
