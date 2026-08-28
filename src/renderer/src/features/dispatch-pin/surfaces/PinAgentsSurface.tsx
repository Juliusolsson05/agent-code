import { isAgentSessionKind } from '@shared/types/providerKind'
import { useMemo } from 'react'
import { PinAgentsModal } from '@renderer/features/dispatch-pin/PinAgentsModal'
import type { PinAgentsModalRow } from '@renderer/features/dispatch-pin/PinAgentsModal'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'
import { resolveTabSessions } from '@renderer/workspace/queries'
import type { SessionId, TabId } from '@renderer/workspace/types'

// Registry wrapper (#494). The candidate-row memo moved here from
// App.tsx for cohesion — the row-building logic now lives next to the
// only surface that consumes it, instead of padding the composition
// root. NOT a perf win: this wrapper is always mounted and re-renders
// whenever App does (WorkspaceContext's value is the per-render hook
// object), and the useMemo deps are unchanged, so the memo recomputes
// on exactly the same schedule as before.
export function PinAgentsSurface() {
  const workspace = useWorkspaceContext()
  const open = useAppStore(state => state.pinAgentsOpen)
  const close = useAppStore(state => state.closePinAgents)
  const { state } = workspace

  // Candidate rows for the Pin Agents modal. Built here (not inside
  // the modal) because we already have cheap access to the full
  // workspace state via the workspace hook — the modal stays a dumb
  // props-driven component.
  //
  // Ordering: currently-pinned agents first in pin order, then
  // everyone else tab-by-tab in tab order. Pinned-first means the
  // user's existing pins surface at the top when they open the
  // modal — the most common operation is "tweak my pins," not
  // "scroll through every agent in the workspace."
  //
  // Terminals are excluded: pin reducer / sanity effect / modal
  // selection all agree pins are agents. Detached agents ARE
  // included — they're the ones the user is most likely pinning
  // (background work they want one keystroke away).
  const rows = useMemo<PinAgentsModalRow[]>(() => {
    const result: PinAgentsModalRow[] = []
    const pinnedSet = new Set(state.pinnedSessionIds)
    const seen = new Set<SessionId>()

    const tabIndexFor = (tabId: TabId): number => state.tabs.findIndex(tab => tab.id === tabId)

    const pushRow = (sessionId: SessionId, tabId: TabId): void => {
      if (seen.has(sessionId)) return
      const meta = state.sessions[sessionId]
      if (!meta || !isAgentSessionKind(meta.kind)) return
      const tabIndex = tabIndexFor(tabId)
      const tab = state.tabs[tabIndex]
      if (!tab) return
      seen.add(sessionId)
      result.push({
        sessionId,
        tabIndex,
        tabTitle: tab.title,
        // Same title fallback the dispatch selectors use — keep this
        // in sync if the title source ever changes. Inlined rather
        // than importing the selector helper because it's two lines.
        title: meta.title?.trim() || meta.cwd?.split('/').filter(Boolean).pop() || 'agent',
      })
    }

    // Pass 1: pinned ids, in pin order. Owner-tab lookup goes through
    // resolveTabSessions so it sees BOTH grid leaves and detached
    // agents owned by the tab. The previous code branched on
    // `state.detachedSessions[sessionId]` before falling back to a
    // grid-only `collectLeaves` walk — the same divergence pattern
    // this whole PR is closing.
    for (const sessionId of state.pinnedSessionIds) {
      const owner = state.tabs.find(tab => resolveTabSessions(state, tab.id).includes(sessionId))
      if (owner) pushRow(sessionId, owner.id)
    }

    // Pass 2: every other agent, tab-by-tab. resolveTabSessions
    // already yields grid leaves first (in tile-tree order) then
    // detached agents oldest-first — exactly the order this modal
    // wants — so no manual interleaving is needed. The pinnedSet
    // check is belt-and-suspenders since `seen` would also catch
    // double-adds, but it makes the intent obvious to a future
    // reader.
    for (const tab of state.tabs) {
      for (const sessionId of resolveTabSessions(state, tab.id)) {
        if (pinnedSet.has(sessionId)) continue
        pushRow(sessionId, tab.id)
      }
    }

    return result
  }, [
    state.detachedSessions,
    state.pinnedSessionIds,
    state.sessions,
    state.tabs,
  ])

  return (
    <PinAgentsModal
      open={open}
      rows={rows}
      initialSelectedIds={state.pinnedSessionIds}
      onCancel={close}
      onConfirm={ids => {
        workspace.setPinnedSessionIds(ids)
        close()
      }}
    />
  )
}
