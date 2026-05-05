import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'

import type { Workspace } from '@renderer/workspace/workspaceStore'
import { useAppStore } from '@renderer/app-state/hooks'
import { TerminalLeaf } from '@renderer/workspace/tile-tree/TerminalLeaf'
import { renderWorkspaceLeaf } from '@renderer/workspace/tile-tree/TileTree'
import { paneLabelForSession } from '@renderer/workspace/tile-tree/paneLabels'
import { WorktreeBadge } from '@renderer/workspace/tile-tree/TileLeaf/SessionBadges'
import { extractLatestUserPrompt } from '@renderer/features/workspace/lib/latestUserPrompts'
import {
  buildDispatchGroups,
  findTerminalSessionInTab,
  flattenDispatchRows,
  selectVisibleDispatchRow,
  type DispatchAgentRow,
} from '@renderer/workspace/dispatch/dispatchSelectors'
import type { SessionId, SessionKind, TabId } from '@renderer/workspace/types'
import type { Entry } from '@shared/types/transcript'
import type { ProviderConditionSnapshot } from '@shared/types/providerConditions'
import { dispatchAttentionLabelFromConditions } from '@renderer/workspace/conditions/selectors'

type DispatchAgentActivity = 'working' | 'running' | 'idle' | 'exited' | 'starting'

const latestPromptTitleCache = new WeakMap<
  Entry[],
  { kind: DispatchAgentRow['kind']; title: string | null }
>()

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
  const rows = useMemo(() => flattenDispatchRows(groups), [groups])
  const activeRow = selectVisibleDispatchRow(
    rows,
    workspace.state.dispatchMode?.focusedSessionId ?? null,
    workspace.activeTab?.focusedSessionId ?? null,
  )
  const activeTab = activeRow
    ? workspace.state.tabs.find(tab => tab.id === activeRow.tabId) ?? null
    : workspace.activeTab
  const terminalSessionId = findTerminalSessionInTab(activeTab, workspace.state)
  const terminalVisible = workspace.state.dispatchMode?.terminalVisible !== false

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
    if (!terminalVisible || !activeTab) return
    void workspace.ensureDispatchTerminal(activeTab.id)
  }, [activeTab?.id, terminalVisible, workspace.ensureDispatchTerminal])

  return (
    <div className="h-full min-h-0 min-w-0 flex overflow-hidden bg-canvas">
      <DispatchAgentList
        groups={groups}
        activeSessionId={activeRow?.sessionId ?? null}
        dispatchScope={workspace.state.dispatchMode?.scope === 'global' ? 'global' : 'project'}
        focusSessionInTab={workspace.focusDispatchSession}
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
            () => workspace.focusDispatchSession(activeRow.tabId, activeRow.sessionId),
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

const DispatchAgentList = memo(function DispatchAgentList({
  groups,
  activeSessionId,
  dispatchScope,
  focusSessionInTab,
  showWorktreeBadges,
}: {
  groups: ReturnType<typeof buildDispatchGroups>
  activeSessionId: string | null
  dispatchScope: 'global' | 'project'
  focusSessionInTab: Workspace['focusSessionInTab']
  showWorktreeBadges: boolean
}) {
  const listRef = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list || !activeSessionId) return
    const activeRow = list.querySelector<HTMLElement>('[data-dispatch-active="true"]')
    if (!activeRow) return

    // WHY not rely on row.scrollIntoView(): Dispatch's list is a nested
    // overflow region with a sticky header, and `scrollIntoView({nearest})`
    // lets the browser pick the scroll ancestor and final alignment. In
    // practice Option+Arrow could move workspace focus while the highlighted
    // row drifted beyond the list viewport. The list container is the source
    // of truth for visibility here, so compute against its own rect and move
    // only its scrollTop.
    const listRect = list.getBoundingClientRect()
    const rowRect = activeRow.getBoundingClientRect()
    const header = list.querySelector<HTMLElement>('[data-dispatch-list-header="true"]')
    const topInset = header?.offsetHeight ?? 0
    const visibleTop = listRect.top + topInset
    const visibleBottom = listRect.bottom

    if (rowRect.top < visibleTop) {
      list.scrollTop -= visibleTop - rowRect.top
    } else if (rowRect.bottom > visibleBottom) {
      list.scrollTop += rowRect.bottom - visibleBottom
    }
  }, [activeSessionId, groups])

  return (
    <aside
      ref={listRef}
      className="basis-1/4 min-w-[220px] max-w-[420px] min-h-0 border-r border-border bg-surface overflow-y-auto [contain:layout_paint]"
    >
      <div
        data-dispatch-list-header="true"
        className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-surface px-2.5 py-1.5 text-[10px] text-muted uppercase"
      >
        <span>Agents</span>
        <span>{dispatchScope}</span>
      </div>
      {groups.map(group => (
        <div key={group.tab.id} className="border-b border-border">
          <DispatchGroupHeader title={group.tab.title} rows={group.rows} />
          <div>
            {group.rows.map(row => (
              <DispatchAgentListRow
                key={row.key}
                row={row}
                active={row.sessionId === activeSessionId}
                showWorktreeBadges={showWorktreeBadges}
                focusSessionInTab={focusSessionInTab}
              />
            ))}
          </div>
        </div>
      ))}
    </aside>
  )
})

const DispatchGroupHeader = memo(function DispatchGroupHeader({
  title,
  rows,
}: {
  title: string
  rows: DispatchAgentRow[]
}) {
  const sessionIds = useMemo(() => rows.map(row => row.sessionId), [rows])
  const runningCount = useAppStore(useShallow(state => {
    let count = 0
    for (const sessionId of sessionIds) {
      const runtime = state.workspaceRuntimes[sessionId]
      if (runtime?.sessionStatus === 'running' || runtime?.streamPhase !== 'idle') count += 1
    }
    return count
  }))

  return (
    <div className="flex items-center justify-between gap-2 px-2.5 py-1 text-[10px] text-ink bg-canvas">
      <span className="truncate">{title}</span>
      <span className="text-muted tabular-nums">
        {runningCount}/{rows.length}
      </span>
    </div>
  )
})

const DispatchAgentListRow = memo(function DispatchAgentListRow({
  row,
  active,
  showWorktreeBadges,
  focusSessionInTab,
}: {
  row: DispatchAgentRow
  active: boolean
  showWorktreeBadges: boolean
  focusSessionInTab: (tabId: TabId, sessionId: SessionId) => void
}) {
  const runtime = useAppStore(useShallow(state => {
    const current = state.workspaceRuntimes[row.sessionId]
    return {
      sessionStatus: current?.sessionStatus,
      streamPhase: current?.streamPhase,
      exited: current?.exited,
      workContext: current?.workContext,
      workActivity: current?.workActivity,
      entries: current?.entries,
      unreadSince: current?.unreadSince,
      unreadKind: current?.unreadKind,
      conditions: current?.conditions,
      processError: current?.processError,
    }
  }))
  const onSelect = useCallback(() => {
    focusSessionInTab(row.tabId, row.sessionId)
  }, [focusSessionInTab, row.sessionId, row.tabId])
  const activity = dispatchActivity(runtime)
  const activityClasses = dispatchActivityClasses(activity, active)
  const subtitle = dispatchSubtitle(runtime)
  const title = runtime.entries
    ? cachedLatestPromptTitle(runtime.entries, row.kind) ?? row.title
    : row.title
  const attentionLabel = dispatchAttentionLabel(runtime)
  const unreadKind = attentionLabel
    ? 'attention'
    : runtime.unreadKind === 'attention'
      ? 'output'
      : runtime.unreadKind

  return (
    <button
      type="button"
      onClick={onSelect}
      title={title}
      data-dispatch-active={active ? 'true' : undefined}
      className={`
        relative w-full text-left px-2.5 py-1 border-t border-border overflow-hidden [contain:layout_paint]
        ${activityClasses.row}
      `}
    >
      <span className={`absolute left-0 top-0 h-full w-[3px] ${activityClasses.rail}`} />
      <div className="flex items-center gap-2 min-w-0">
        <span className={`flex-shrink-0 text-[10px] tabular-nums ${active ? 'text-accent' : 'text-muted'}`}>
          {row.label}
        </span>
        <span className={`flex-1 min-w-0 truncate px-1 py-[1px] text-[11px] text-ink ${activityClasses.title}`}>
          {title}
        </span>
        {unreadKind && (
          <DispatchUnreadBadge kind={unreadKind} label={attentionLabel} />
        )}
      </div>
      {/* Row 2 — secondary metadata. Worktree + model are split off the
          title row so the title can use the full row width before
          truncating. The activity status (running/idle/working) stays
          here too because the rail color alone doesn't disambiguate
          working vs running for users who can't easily compare hues. */}
      <div className="mt-0.5 pl-7 flex items-center gap-1.5 min-w-0 text-[9px] text-muted">
        <span className="truncate flex-shrink min-w-0">{subtitle}</span>
        {showWorktreeBadges && (
          <WorktreeBadge context={runtime?.workContext} activity={runtime?.workActivity} />
        )}
        <DispatchAgentBadge kind={row.kind} />
      </div>
    </button>
  )
})

function cachedLatestPromptTitle(
  entries: Entry[],
  kind: DispatchAgentRow['kind'],
): string | null {
  const cached = latestPromptTitleCache.get(entries)
  if (cached && cached.kind === kind) return cached.title

  const title = extractLatestUserPrompt(entries, kind)?.text ?? null
  latestPromptTitleCache.set(entries, { kind, title })
  return title
}

function dispatchSubtitle(runtime: {
  sessionStatus?: string
  streamPhase?: string
  exited?: number | null
  unreadSince?: number | null
}): string {
  if (runtime.sessionStatus === undefined) return 'starting'
  if (runtime.streamPhase && runtime.streamPhase !== 'idle') return runtime.streamPhase
  if (runtime.sessionStatus === 'running') return 'running'
  if (runtime.exited !== null && runtime.exited !== undefined) return 'exited'
  return 'idle'
}

function dispatchAttentionLabel(runtime: {
  conditions?: ProviderConditionSnapshot | null
  processError?: string | null
}): string | null {
  const conditionLabel = dispatchAttentionLabelFromConditions(runtime.conditions ?? null)
  if (conditionLabel) return conditionLabel
  if (runtime.processError) return 'ERROR'
  return null
}

// Dispatch-local agent badge. Why not reuse AgentTypeBadge from
// SessionBadges? That component is also rendered in pane headers
// (ScrollIndicator) where the longer "Claude Code" reads naturally.
// In the narrow dispatch row we want the shorter "Claude" so the
// badge doesn't crowd the worktree pill on row 2.
function DispatchAgentBadge({ kind }: { kind: SessionKind | undefined }) {
  const label =
    kind === 'codex' ? 'Codex' : kind === 'terminal' ? 'Terminal' : 'Claude'
  return (
    <span className="flex-shrink-0 px-1.5 py-[1px] text-[9px] font-code leading-none text-muted border border-border bg-surface-hi">
      {label}
    </span>
  )
}

function DispatchUnreadBadge({
  kind,
  label,
}: {
  kind: 'output' | 'attention'
  label: string | null
}) {
  if (kind === 'attention') {
    return (
      <span
        className="
          flex-shrink-0 rounded-sm border border-amber-300/70 bg-amber-400/20
          px-1.5 py-[1px] text-[9px] font-semibold leading-none text-amber-100
        "
      >
        {label ?? 'ACTION'}
      </span>
    )
  }
  return (
    <span
      className="
        flex-shrink-0 rounded-sm border border-accent/70 bg-accent/20
        px-1.5 py-[1px] text-[9px] font-semibold leading-none text-accent
      "
    >
      NEW
    </span>
  )
}

function dispatchActivity(runtime: {
  sessionStatus?: string
  streamPhase?: string
  exited?: number | null
}): DispatchAgentActivity {
  if (runtime.sessionStatus === undefined) return 'starting'
  if (runtime.exited !== null && runtime.exited !== undefined) return 'exited'
  if (runtime.streamPhase && runtime.streamPhase !== 'idle') return 'working'
  if (runtime.sessionStatus === 'running') return 'running'
  return 'idle'
}

function dispatchActivityClasses(
  activity: DispatchAgentActivity,
  active: boolean,
): {
  row: string
  rail: string
  title: string
} {
  if (active) {
    return {
      row: 'bg-accent-soft text-ink',
      rail: 'bg-accent',
      title: activity === 'working' || activity === 'running'
        ? 'bg-accent-soft'
        : '',
    }
  }
  if (activity === 'working') {
    return {
      row: 'bg-green-500/10 hover:bg-green-500/15 text-ink',
      rail: 'bg-green-400',
      title: 'bg-green-500/15',
    }
  }
  if (activity === 'running') {
    return {
      row: 'bg-cyan-500/10 hover:bg-cyan-500/15 text-ink',
      rail: 'bg-cyan-400',
      title: 'bg-cyan-500/15',
    }
  }
  if (activity === 'starting') {
    return {
      row: 'bg-yellow-500/10 hover:bg-yellow-500/15 text-ink',
      rail: 'bg-yellow-400',
      title: 'bg-yellow-500/15',
    }
  }
  if (activity === 'exited') {
    return {
      row: 'bg-surface hover:bg-surface-hi text-muted opacity-75',
      rail: 'bg-border-hi',
      title: '',
    }
  }
  return {
    row: 'bg-surface hover:bg-surface-hi text-ink-dim',
    rail: 'bg-transparent',
    title: '',
  }
}

function DispatchEmpty({ message }: { message: string }) {
  return (
    <div className="h-full flex items-center justify-center text-[12px] text-muted">
      {message}
    </div>
  )
}
