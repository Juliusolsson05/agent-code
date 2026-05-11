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

  // Pins live in their own section at the top of the list. A pinned
  // session is intentionally NOT also rendered in its project group —
  // duplicating the row would make cmd+N ambiguous (two rows resolve
  // to the same sessionId) and would lie about the visual hierarchy
  // ("this is in two places at once"). Same exclusivity invariant as
  // detached-vs-grid: each row belongs to exactly one bucket.
  const pinnedSet = new Set(state.pinnedSessionIds)

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
        .filter(sessionId => !pinnedSet.has(sessionId))
      const detachedSessionIds = detachedDispatchSessionIdsForTab(state, tab.id)
        .filter(sessionId => !pinnedSet.has(sessionId))

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

export function dispatchSessionIdsForTab(
  state: WorkspaceState,
  tabId: TabId,
): SessionId[] {
  return buildDispatchGroups(state)
    .find(group => group.tab.id === tabId)
    ?.rows.map(row => row.sessionId) ?? []
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

/**
 * Build the rows that render in the "Pinned" section at the top of
 * DispatchAgentList. Order matches `state.pinnedSessionIds` exactly
 * (first pinned == top of section).
 *
 * Unlike buildDispatchGroups, this is NOT scope-aware: pins are
 * cross-project by design and the Pinned section always shows every
 * pin regardless of whether dispatch is in project or global scope.
 * The per-row `tabIndex` is still returned so the renderer can show
 * the small project chip and so cmd+N keyboard dispatch resolves to
 * the right tab.
 *
 * Pinned sessions that no longer exist are silently dropped. The
 * autosave filter in useAutoSave.ts should catch these on normal
 * removal, but a stale entry surviving the durability boundary
 * (e.g. a race during fresh-workspace bootstrap, hand-edited
 * workspace.json) must not produce a row that resolves to nothing
 * on focus — so we also drop here at render time.
 */
export function buildPinnedDispatchRows(
  state: WorkspaceState,
): DispatchAgentRow[] {
  const rows: DispatchAgentRow[] = []
  let pinnedIndex = 1
  for (const sessionId of state.pinnedSessionIds) {
    const meta = state.sessions[sessionId]
    if (!meta || meta.kind === 'terminal') continue
    // Locate the owning tab. A pinned agent that's detached has its
    // tab id on `detachedSessions[sessionId].projectTabId`; a
    // grid-placed pinned agent is a leaf in some tab's tree. We do
    // the lookup detached-first because detachedSessions is O(1) and
    // catches the "background pinned agent" case the user is likely
    // pinning in the first place (an agent they don't want crowding
    // the visible grid but want one keystroke away).
    const detached = state.detachedSessions[sessionId]
    let tabId: TabId | null = null
    let placement: 'grid' | 'detached' = 'grid'
    if (detached) {
      tabId = detached.projectTabId
      placement = 'detached'
    } else {
      const owner = state.tabs.find(tab =>
        collectLeaves(tab.root).includes(sessionId),
      )
      tabId = owner?.id ?? null
    }
    if (!tabId) continue
    const tabIndex = state.tabs.findIndex(tab => tab.id === tabId)
    const tab = state.tabs[tabIndex]
    if (!tab) continue
    rows.push({
      // ★ prefix keeps the row key unique against project-group rows
      // (whose keys are `${tabId}:${placement}:${sessionId}`) so any
      // caller that flat-concats both arrays — see the spread in
      // DispatchLayout — won't collide on React keys.
      key: `pinned:${sessionId}`,
      label: `★${pinnedIndex}`,
      globalIndex: pinnedIndex,
      tabId,
      tabTitle: tab.title,
      tabIndex,
      sessionId,
      kind: meta.kind,
      title: sessionTitle(meta),
      placement,
    })
    pinnedIndex += 1
  }
  return rows
}

/**
 * Convenience predicate for one-shot pin checks from commands and
 * other UI surfaces. Hot-path callers should build a local
 * `Set(state.pinnedSessionIds)` instead (see buildDispatchGroups);
 * this helper trades that O(n) array scan for ergonomics.
 */
export function isPinned(state: WorkspaceState, sessionId: SessionId): boolean {
  return state.pinnedSessionIds.includes(sessionId)
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
