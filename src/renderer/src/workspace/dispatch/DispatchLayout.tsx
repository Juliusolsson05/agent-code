import { memo, useCallback, useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'

import type { Workspace } from '@renderer/workspace/workspaceStore'
import { useAppStore } from '@renderer/app-state/hooks'
import { TerminalLeaf } from '@renderer/workspace/tile-tree/TerminalLeaf'
import { renderWorkspaceLeaf } from '@renderer/workspace/tile-tree/TileTree'
import { paneLabelForSession } from '@renderer/workspace/tile-tree/paneLabels'
import { AgentTypeBadge, WorktreeBadge } from '@renderer/workspace/tile-tree/TileLeaf/SessionBadges'
import { extractLatestUserPrompt } from '@renderer/features/workspace/lib/latestUserPrompts'
import {
  buildDispatchGroups,
  findTerminalSessionInTab,
  flattenDispatchRows,
  type DispatchAgentRow,
} from '@renderer/workspace/dispatch/dispatchSelectors'
import type { SessionId, TabId } from '@renderer/workspace/types'
import type { Entry } from '@shared/types/transcript'

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
        dispatchScope={workspace.state.dispatchMode?.scope === 'global' ? 'global' : 'project'}
        focusSessionInTab={workspace.focusSessionInTab}
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
  return (
    <aside className="basis-1/4 min-w-[220px] max-w-[420px] min-h-0 border-r border-border bg-surface overflow-y-auto [contain:layout_paint]">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-surface px-3 py-2 text-[10px] text-muted uppercase">
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
    <div className="flex items-center justify-between gap-2 px-3 py-2 text-[11px] text-ink bg-canvas">
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
      pendingApproval: current?.pendingApproval,
      pendingTrustDialog: current?.pendingTrustDialog,
      pendingResumePrompt: current?.pendingResumePrompt,
      pendingPermissionPrompt: current?.pendingPermissionPrompt,
      pendingCompaction: current?.pendingCompaction,
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
      className={`
        relative w-full text-left px-3 py-2 border-t border-border overflow-hidden [contain:layout_paint]
        ${activityClasses.row}
      `}
    >
      <span className={`absolute left-0 top-0 h-full w-[3px] ${activityClasses.rail}`} />
      <div className="flex items-center gap-2 min-w-0">
        <span className={`flex-shrink-0 text-[10px] tabular-nums ${active ? 'text-accent' : 'text-muted'}`}>
          {row.label}
        </span>
        <span className={`flex-1 min-w-0 truncate px-1 py-[1px] text-[12px] text-ink ${activityClasses.title}`}>
          {title}
        </span>
        {showWorktreeBadges && (
          <WorktreeBadge context={runtime?.workContext} activity={runtime?.workActivity} />
        )}
        <AgentTypeBadge kind={row.kind} />
        {unreadKind && (
          <DispatchUnreadBadge kind={unreadKind} label={attentionLabel} />
        )}
      </div>
      <div className="mt-1 pl-7 text-[10px] text-muted truncate">
        {subtitle}
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
  pendingApproval?: unknown
  pendingTrustDialog?: unknown
  pendingResumePrompt?: unknown
  pendingPermissionPrompt?: unknown
  pendingCompaction?: { phase?: string } | null
  processError?: string | null
}): string | null {
  if (runtime.pendingPermissionPrompt) return 'ACTION'
  if (runtime.pendingApproval) return 'ACTION'
  if (runtime.pendingTrustDialog) return 'TRUST'
  if (runtime.pendingResumePrompt) return 'RESUME'
  if (runtime.pendingCompaction?.phase === 'error') return 'ERROR'
  if (runtime.processError) return 'ERROR'
  return null
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
          shadow-[0_0_12px_rgba(251,191,36,0.22)]
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
        shadow-[0_0_12px_rgba(56,189,248,0.18)]
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

function selectActiveRow(rows: DispatchAgentRow[], focusedSessionId: string | null): DispatchAgentRow | null {
  if (focusedSessionId) {
    const focused = rows.find(row => row.sessionId === focusedSessionId)
    if (focused) return focused
  }
  return rows[0] ?? null
}
