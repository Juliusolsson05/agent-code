import { useEffect, useMemo } from 'react'

import type { Workspace } from '@renderer/workspace/workspaceStore'
import { TerminalLeaf } from '@renderer/workspace/tile-tree/TerminalLeaf'
import { renderWorkspaceLeaf } from '@renderer/workspace/tile-tree/TileTree'
import { paneLabelForSession } from '@renderer/workspace/tile-tree/paneLabels'
import { AgentTypeBadge, WorktreeBadge } from '@renderer/workspace/tile-tree/TileLeaf/SessionBadges'
import {
  buildDispatchGroups,
  findTerminalSessionInTab,
  flattenDispatchRows,
  type DispatchAgentRow,
} from '@renderer/workspace/dispatch/dispatchSelectors'

type Props = {
  workspace: Workspace
  showStatusMode: boolean
  showWorktreeBadges: boolean
}

export function DispatchLayout({
  workspace,
  showStatusMode,
  showWorktreeBadges,
}: Props) {
  const groups = useMemo(
    () => buildDispatchGroups(workspace.state, workspace.runtimes),
    [workspace.runtimes, workspace.state],
  )
  const rows = useMemo(() => flattenDispatchRows(groups), [groups])
  const activeRow = selectActiveRow(rows, workspace.activeTab?.focusedSessionId ?? null)
  const activeTab = activeRow
    ? workspace.state.tabs.find(tab => tab.id === activeRow.tabId) ?? null
    : workspace.activeTab
  const terminalSessionId = findTerminalSessionInTab(activeTab, workspace.state)
  const terminalVisible = workspace.state.dispatchMode?.terminalVisible !== false

  useEffect(() => {
    if (!activeRow) return
    if (
      workspace.activeTab?.id === activeRow.tabId &&
      workspace.activeTab.focusedSessionId === activeRow.sessionId
    ) {
      return
    }
    // Global Dispatch can render a fallback row when the currently active
    // tab has no visible agent rows. Keep the workspace focus aligned with
    // that visible row so tab chrome, new-agent placement, and project
    // terminal selection all agree with what the user is commanding.
    workspace.focusSessionInTab(activeRow.tabId, activeRow.sessionId)
  }, [
    activeRow?.sessionId,
    activeRow?.tabId,
    workspace.activeTab?.focusedSessionId,
    workspace.activeTab?.id,
    workspace.focusSessionInTab,
  ])

  useEffect(() => {
    if (!terminalVisible || !activeTab) return
    void workspace.ensureDispatchTerminal(activeTab.id)
  }, [activeTab?.id, terminalVisible, workspace.ensureDispatchTerminal])

  return (
    <div className="h-full min-h-0 min-w-0 flex overflow-hidden bg-canvas">
      <DispatchAgentList
        groups={groups}
        activeSessionId={activeRow?.sessionId ?? null}
        workspace={workspace}
        showWorktreeBadges={showWorktreeBadges}
      />

      <div className={`${terminalVisible ? 'basis-1/2' : 'basis-3/4'} min-w-0 min-h-0 border-r border-border`}>
        {activeRow ? (
          renderWorkspaceLeaf(
            activeRow.sessionId,
            activeRow.sessionId,
            workspace,
            activeRow.tabId,
            showStatusMode,
            showWorktreeBadges,
          )
        ) : (
          <DispatchEmpty message="no agents in this dispatch scope" />
        )}
      </div>

      {terminalVisible && (
        <div className="basis-1/4 min-w-0 min-h-0">
          {activeTab && terminalSessionId ? (
            <TerminalLeaf
              sessionId={terminalSessionId}
              paneLabel={paneLabelForSession(
                workspace.state.tabs,
                activeTab.id,
                terminalSessionId,
              )}
              focused={false}
              onFocusRequest={() => {}}
              workspace={workspace}
            />
          ) : (
            <DispatchEmpty message="creating project terminal..." />
          )}
        </div>
      )}
    </div>
  )
}

function DispatchAgentList({
  groups,
  activeSessionId,
  workspace,
  showWorktreeBadges,
}: {
  groups: ReturnType<typeof buildDispatchGroups>
  activeSessionId: string | null
  workspace: Workspace
  showWorktreeBadges: boolean
}) {
  return (
    <aside className="basis-1/4 min-w-[220px] max-w-[420px] min-h-0 border-r border-border bg-surface overflow-y-auto">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-surface px-3 py-2 text-[10px] text-muted uppercase">
        <span>Agents</span>
        <span>{workspace.state.dispatchMode?.scope === 'global' ? 'global' : 'project'}</span>
      </div>
      {groups.map(group => (
        <div key={group.tab.id} className="border-b border-border">
          <div className="flex items-center justify-between gap-2 px-3 py-2 text-[11px] text-ink bg-canvas">
            <span className="truncate">{group.tab.title}</span>
            <span className="text-muted tabular-nums">
              {group.rows.filter(row => workspace.runtimes[row.sessionId]?.sessionStatus === 'running').length}/{group.rows.length}
            </span>
          </div>
          <div>
            {group.rows.map(row => (
              <DispatchAgentListRow
                key={row.key}
                row={row}
                active={row.sessionId === activeSessionId}
                runtime={workspace.runtimes[row.sessionId]}
                showWorktreeBadges={showWorktreeBadges}
                onSelect={() => workspace.focusSessionInTab(row.tabId, row.sessionId)}
              />
            ))}
          </div>
        </div>
      ))}
    </aside>
  )
}

function DispatchAgentListRow({
  row,
  active,
  runtime,
  showWorktreeBadges,
  onSelect,
}: {
  row: DispatchAgentRow
  active: boolean
  runtime: Workspace['runtimes'][string] | undefined
  showWorktreeBadges: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`
        w-full text-left px-3 py-2 border-t border-border
        ${active ? 'bg-accent-soft text-ink' : 'bg-surface hover:bg-surface-hi text-ink-dim'}
      `}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className={`flex-shrink-0 text-[10px] tabular-nums ${active ? 'text-accent' : 'text-muted'}`}>
          {row.label}
        </span>
        <span className="flex-1 min-w-0 truncate text-[12px] text-ink">
          {row.title}
        </span>
        {showWorktreeBadges && (
          <WorktreeBadge context={runtime?.workContext} activity={runtime?.workActivity} />
        )}
        <AgentTypeBadge kind={row.kind} />
      </div>
      <div className="mt-1 pl-7 text-[10px] text-muted truncate">
        {row.subtitle}
      </div>
    </button>
  )
}

function DispatchEmpty({ message }: { message: string }) {
  return (
    <div className="h-full flex items-center justify-center text-[12px] text-muted">
      {message}
    </div>
  )
}

function selectActiveRow(rows: DispatchAgentRow[], focusedSessionId: string | null): DispatchAgentRow | null {
  if (focusedSessionId) {
    const focused = rows.find(row => row.sessionId === focusedSessionId)
    if (focused) return focused
  }
  return rows[0] ?? null
}
