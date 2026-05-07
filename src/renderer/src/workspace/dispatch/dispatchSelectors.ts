import type { SessionId, SessionKind, Tab, TabId, WorkspaceState } from '@renderer/workspace/types'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import { tabIndexLabel } from '@renderer/workspace/tile-tree/paneLabels'

export type DispatchAgentRow = {
  key: string
  label: string
  globalIndex: number
  tabId: TabId
  tabTitle: string
  tabIndex: number
  sessionId: SessionId
  kind: SessionKind | undefined
  title: string
  placement: 'grid' | 'detached'
}

export type DispatchTabGroup = {
  tab: Tab
  tabIndex: number
  rows: DispatchAgentRow[]
}

export function buildDispatchGroups(
  state: WorkspaceState,
): DispatchTabGroup[] {
  const activeOnly = state.dispatchMode?.scope !== 'global'
  const sourceTabs = activeOnly
    ? state.tabs.filter(tab => tab.id === state.activeTabId)
    : state.tabs

  // The tab letter answers "which project group owns this row"; the
  // number answers "which visible dispatch item will cmd+N select".
  // That intentionally gives labels like A1, A2, B3, C4 in Global
  // Dispatch. Reusing pane-local numbers (B1, C1) looked tidy but made
  // keyboard dispatch ambiguous once multiple projects were visible.
  let globalIndex = 1
  return sourceTabs
    .map(tab => {
      const tabIndex = state.tabs.findIndex(item => item.id === tab.id)
      const gridSessionIds = collectLeaves(tab.root)
        .filter(sessionId => state.sessions[sessionId]?.kind !== 'terminal')
      const detachedSessionIds = detachedDispatchSessionIdsForTab(state, tab.id)

      const rows = [
        ...gridSessionIds.map(sessionId => ({ sessionId, placement: 'grid' as const })),
        ...detachedSessionIds.map(sessionId => ({ sessionId, placement: 'detached' as const })),
      ]
        .map(({ sessionId, placement }) => {
          const meta = state.sessions[sessionId]
          const rowIndex = globalIndex++
          return {
            key: `${tab.id}:${placement}:${sessionId}`,
            label: `${tabIndexLabel(tabIndex)}${rowIndex}`,
            globalIndex: rowIndex,
            tabId: tab.id,
            tabTitle: tab.title,
            tabIndex,
            sessionId,
            kind: meta?.kind,
            title: sessionTitle(meta),
            placement,
          } satisfies DispatchAgentRow
        })
      return { tab, tabIndex, rows } satisfies DispatchTabGroup
    })
    .filter(group => group.rows.length > 0)
}

export function flattenDispatchRows(groups: DispatchTabGroup[]): DispatchAgentRow[] {
  return groups.flatMap(group => group.rows)
}

export function detachedDispatchSessionIdsForTab(
  state: WorkspaceState,
  tabId: TabId,
): SessionId[] {
  // Keep this ordering in one place so the list UI and bulk attach agree on
  // what "all Dispatch agents for this tab" means. Detached rows are displayed
  // oldest-first in buildDispatchGroups; bulk attach should preserve that same
  // user-visible sequence inside the normalized incoming subtree.
  return Object.values(state.detachedSessions)
    .filter(entry => (
      entry.surface === 'dispatch' &&
      entry.projectTabId === tabId &&
      state.sessions[entry.sessionId] !== undefined &&
      state.sessions[entry.sessionId]?.kind !== 'terminal'
    ))
    .sort((a, b) => a.detachedAt - b.detachedAt)
    .map(entry => entry.sessionId)
}

export function selectVisibleDispatchRow(
  rows: DispatchAgentRow[],
  dispatchFocusedSessionId: SessionId | null | undefined,
  gridFocusedSessionId: SessionId | null | undefined,
): DispatchAgentRow | null {
  // WHY this selector lives with the row builder:
  // Dispatch has two focus-like ids in play. `dispatchFocusedSessionId` is the
  // persisted command selection, while `gridFocusedSessionId` is the active
  // tab's tile-tree focus used as a fallback when Dispatch focus is absent or
  // stale. The visible UI already follows this order in DispatchLayout; command
  // visibility and destructive actions must follow the same row-derived target
  // or the highlighted row and the command target drift apart again.
  for (const candidate of [dispatchFocusedSessionId, gridFocusedSessionId]) {
    if (!candidate) continue
    const focused = rows.find(row => row.sessionId === candidate)
    if (focused) return focused
  }
  return rows[0] ?? null
}

export function findTerminalSessionInTab(
  tab: Tab | null,
  state: WorkspaceState,
): SessionId | null {
  if (!tab) return null
  return collectLeaves(tab.root).find(id => state.sessions[id]?.kind === 'terminal') ?? null
}

function sessionTitle(
  meta: WorkspaceState['sessions'][SessionId] | undefined,
): string {
  if (meta?.title?.trim()) return meta.title.trim()
  return basename(meta?.cwd ?? 'agent')
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}
