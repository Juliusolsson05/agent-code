import type { SessionId, SessionKind, Tab, TabId, WorkspaceState } from '@renderer/workspace/types'
import type { SessionRuntime } from '@renderer/workspace/workspaceState'
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
  subtitle: string
}

export type DispatchTabGroup = {
  tab: Tab
  tabIndex: number
  rows: DispatchAgentRow[]
}

export function buildDispatchGroups(
  state: WorkspaceState,
  runtimes: Record<SessionId, SessionRuntime>,
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
      const rows = collectLeaves(tab.root)
        .filter(sessionId => state.sessions[sessionId]?.kind !== 'terminal')
        .map(sessionId => {
          const meta = state.sessions[sessionId]
          const runtime = runtimes[sessionId]
          const rowIndex = globalIndex++
          return {
            key: `${tab.id}:${sessionId}`,
            label: `${tabIndexLabel(tabIndex)}${rowIndex}`,
            globalIndex: rowIndex,
            tabId: tab.id,
            tabTitle: tab.title,
            tabIndex,
            sessionId,
            kind: meta?.kind,
            title: sessionTitle(meta, runtime),
            subtitle: sessionSubtitle(runtime),
          } satisfies DispatchAgentRow
        })
      return { tab, tabIndex, rows } satisfies DispatchTabGroup
    })
    .filter(group => group.rows.length > 0)
}

export function flattenDispatchRows(groups: DispatchTabGroup[]): DispatchAgentRow[] {
  return groups.flatMap(group => group.rows)
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
  runtime: SessionRuntime | undefined,
): string {
  if (meta?.title?.trim()) return meta.title.trim()
  return basename(meta?.cwd ?? runtime?.projectDir ?? 'agent')
}

function sessionSubtitle(runtime: SessionRuntime | undefined): string {
  if (!runtime) return 'starting'
  if (runtime.streamPhase !== 'idle') return runtime.streamPhase
  if (runtime.sessionStatus === 'running') return 'running'
  if (runtime.exited !== null) return 'exited'
  return 'idle'
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}
