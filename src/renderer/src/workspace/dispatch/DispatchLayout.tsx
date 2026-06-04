import { useCallback, useEffect, useMemo, useRef } from 'react'

import type { Workspace } from '@renderer/workspace/workspaceStore'
import { useAppStore } from '@renderer/app-state/hooks'
import { SplitHandle } from '@renderer/features/shared/SplitHandle'
import { useResizableSplitter } from '@renderer/features/shared/useResizableSplitter'
import { TerminalLeaf } from '@renderer/workspace/tile-tree/TerminalLeaf'
import { renderWorkspaceLeaf } from '@renderer/workspace/tile-tree/TileTree'
import { paneLabelForSession } from '@renderer/workspace/tile-tree/paneLabels'
import {
  buildDispatchGroups,
  buildPinnedDispatchRows,
  buildVisibleDispatchRows,
  findTerminalSessionInTab,
  selectVisibleDispatchRow,
} from '@renderer/workspace/dispatch/dispatchSelectors'
import {
  DispatchAgentList,
  DispatchEmpty,
} from '@renderer/workspace/dispatch/DispatchAgentList'

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
    () => buildDispatchGroups(workspace.state),
    [workspace.state],
  )
  const pinnedRows = useMemo(
    () => buildPinnedDispatchRows(workspace.state),
    [workspace.state],
  )
  // Pinned rows participate in keyboard dispatch (cmd+N) and in
  // "which row is currently focused?" selection — they're real
  // dispatch rows, just rendered in their own section. Prepending
  // them here makes the focus fallback prefer a pinned row over
  // anything else when the explicit focus id is stale, which matches
  // the Pinned section's visual position at the top of the list.
  const rows = useMemo(
    () => buildVisibleDispatchRows(workspace.state),
    [workspace.state],
  )
  const activeRow = selectVisibleDispatchRow(
    rows,
    workspace.state.dispatchMode?.focusedSessionId ?? null,
    workspace.activeTab?.focusedSessionId ?? null,
  )
  const activeTab = activeRow
    ? workspace.state.tabs.find(tab => tab.id === activeRow.tabId) ?? null
    : workspace.activeTab
  const terminalSessionId = findTerminalSessionInTab(activeTab, workspace.state)
  // Source of truth for whether the project terminal mounts is now the
  // global setting, not the ephemeral `dispatchMode.terminalVisible` we
  // used to keep on workspace state. The setting defaults to OFF —
  // matches the user's "off by default, opt in" intent and removes the
  // "I turned it off but it came back" failure mode that the per-session
  // flag suffered from. Toggle is in Settings → Workspace.
  const terminalVisible = useAppStore(state => state.settings.dispatchProjectTerminal)

  // Resizable list/active-agent split. The ratio is owned by uiShell
  // (see UiShellState.dispatchListRatio) so it survives mode toggles
  // without being re-derived from workspace state. We measure against
  // the outer flex row's bounding rect, NOT the viewport, because the
  // dispatch layout can be wrapped by the Global Editor overlay — at
  // which point its "100% width" is much narrower than the screen.
  //
  // The clamp in setDispatchListRatio (0.15..0.5) is the real bound;
  // we deliberately do NOT keep the previous `min-w-[220px]
  // max-w-[420px]` Tailwind classes on the list — they would override
  // the user's drag and create a visual disconnect between the
  // splitter handle and the actual list edge at narrow / wide
  // viewports. If a user manages to get the list unreadably narrow at
  // a tiny viewport, the 15% floor still applies.
  const dispatchListRatio = useAppStore(state => state.dispatchListRatio)
  const setDispatchListRatio = useAppStore(state => state.setDispatchListRatio)
  const layoutRowRef = useRef<HTMLDivElement | null>(null)
  const listSplitter = useResizableSplitter({
    onDrag: useCallback(
      (clientX: number) => {
        const el = layoutRowRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0) return
        setDispatchListRatio((clientX - rect.left) / rect.width)
      },
      [setDispatchListRatio],
    ),
  })

  useEffect(() => {
    if (!activeRow) return
    if (
      workspace.activeTab?.id === activeRow.tabId &&
      workspace.state.dispatchMode?.focusedSessionId === activeRow.sessionId
    ) {
      return
    }
    // Global Dispatch can render a fallback row when the currently active
    // tab has no visible agent rows. Keep the workspace focus aligned with
    // that visible row so tab chrome, new-agent placement, and project
    // terminal selection all agree with what the user is commanding.
    workspace.focusDispatchSession(activeRow.tabId, activeRow.sessionId)
  }, [
    activeRow?.sessionId,
    activeRow?.tabId,
    workspace.activeTab?.id,
    workspace.focusDispatchSession,
    workspace.state.dispatchMode?.focusedSessionId,
  ])

  useEffect(() => {
    // Spawn the terminal lazily when the user opts in. This is the ONLY
    // entry point that calls ensureDispatchTerminal — the dispatch
    // actions (enter/setScope) deliberately no longer do, so flipping
    // the setting OFF and re-entering Dispatch will NOT silently spawn
    // a fresh terminal in the background. The existing terminal in a
    // tab that was spawned earlier stays as a tile-tree leaf; if the
    // user wants to remove it, they close it like any other pane.
    if (!terminalVisible || !activeTab) return
    void workspace.ensureDispatchTerminal(activeTab.id)
  }, [activeTab?.id, terminalVisible, workspace.ensureDispatchTerminal])

  // List width is the ratio * row width. Active-agent pane absorbs
  // the remainder via `flex-1`. When the project terminal is on, we
  // give it a fixed-percentage column (25%) that doesn't move with
  // the splitter — the splitter only controls the list/active
  // boundary, never the terminal column.
  const listWidthPct = (dispatchListRatio * 100).toFixed(2)

  return (
    <div
      ref={layoutRowRef}
      className="h-full min-h-0 min-w-0 flex overflow-hidden bg-canvas"
    >
      <div
        className="flex-shrink-0 min-h-0 border-r border-border"
        style={{ width: `${listWidthPct}%` }}
      >
        <DispatchAgentList
          groups={groups}
          pinnedRows={pinnedRows}
          activeSessionId={activeRow?.sessionId ?? null}
          dispatchScope={workspace.state.dispatchMode?.scope === 'global' ? 'global' : 'project'}
          focusSessionInTab={workspace.focusDispatchSession}
          showWorktreeBadges={showWorktreeBadges}
        />
      </div>

      {/*
        List/active splitter. Visible bar is 4px; hit area is 10px so
        the bar can be grabbed without pixel-perfect aim. We render
        between the list wrapper and the active-agent pane; the
        wrapper takes the inline width, the splitter is fixed
        (flex-shrink-0), and the active pane uses flex-1 to absorb
        the remainder.
      */}
      <SplitHandle
        dragging={listSplitter.dragging}
        onMouseDown={listSplitter.onMouseDown}
        hitSizePx={10}
        barSizePx={4}
      />
      {listSplitter.cursorLock}

      <div className="flex-1 min-w-0 min-h-0 border-r border-border">
        {activeRow ? (
          renderWorkspaceLeaf(
            activeRow.sessionId,
            activeRow.sessionId,
            workspace,
            activeRow.tabId,
            showStatusMode,
            showWorktreeBadges,
            () => workspace.focusDispatchSession(activeRow.tabId, activeRow.sessionId),
          )
        ) : (
          <DispatchEmpty message="no sessions in this dispatch scope" />
        )}
      </div>

      {terminalVisible && activeRow?.sessionId !== terminalSessionId && (
        <div className="basis-1/4 min-w-0 min-h-0 flex-shrink-0">
          {activeTab && terminalSessionId ? (
            <TerminalLeaf
              sessionId={terminalSessionId}
              paneLabel={paneLabelForSession(
                workspace.state,
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
