import { TldrPane } from '@renderer/features/tldr/TldrOverlay'
import { GoalLoopPane } from '@renderer/features/goal-loop/GoalLoopPane'
import { DEFAULT_PROVIDER } from '@shared/types/providerKind'
import { memo, useCallback } from 'react'
import { useSessionRuntime } from '@renderer/workspace/useSessionRuntime'

import { getRendererProvider } from '@providers/registry.renderer'
import type { AgentViewMode } from '@renderer/app-state/settings/types'
import { getEffectiveAgentSurfaceForSession } from '@renderer/workspace/agentDisplayMode'
import { AgentTerminalLeaf } from '@renderer/workspace/tile-tree/AgentTerminalLeaf'
import { MountedAgentTerminalOwner } from '@renderer/workspace/terminal/AgentTerminalOwnership'
import { TerminalLeaf } from '@renderer/workspace/tile-tree/TerminalLeaf'
import { ExtensionViewLeaf } from '@renderer/workspace/tile-tree/ExtensionViewLeaf'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { SessionId, TabId } from '@renderer/workspace/types'
import { paneLabelForSession } from '@renderer/workspace/tile-tree/paneLabels'

// The workspace leaf renderer.
//
// This file used to be the recursive renderer for a tab's binary-split tree:
// a `TileTree` component, a draggable `SplitContainer`, and the leaf renderer
// below. The unified layout (#992) deleted the tree — the stage's lanes are the
// only place a session is shown — and what survives is the part every surface
// always funnelled through: `renderWorkspaceLeaf`, which picks the right view
// (terminal, extension view, raw agent terminal, provider feed) for a session.
// Lanes, Spotlight and tests all call it; the file keeps its path so those
// importers did not have to move in the same change.

// No defaults for the tab, view mode or display settings (#856): Spotlight and
// Tiled Tabs once silently got `true` for Status Mode and worktree badges
// because a default existed. Every caller is a surface that knows these
// values, and a default would hide the one that doesn't pass them.
export function renderWorkspaceLeaf(
  sessionId: SessionId,
  focusedSessionId: SessionId | null,
  workspace: Workspace,
  tabId: TabId,
  agentViewMode: AgentViewMode,
  showStatusMode: boolean,
  showWorktreeBadges: boolean,
  onFocusRequest?: () => void,
  surfacePaneLabel?: string,
) {
  return <WorkspaceLeaf
    sessionId={sessionId}
    focusedSessionId={focusedSessionId}
    workspace={workspace}
    tabId={tabId}
    agentViewMode={agentViewMode}
    showStatusMode={showStatusMode}
    showWorktreeBadges={showWorktreeBadges}
    onFocusRequest={onFocusRequest}
    surfacePaneLabel={surfacePaneLabel}
  />
}

// The subscription belongs below the recursive layout and above provider/view
// selection: a runtime can change Hybrid's surface, but another session's
// output must not traverse this pane or recreate any terminal callbacks.
const WorkspaceLeaf = memo(function WorkspaceLeaf({
  sessionId, focusedSessionId, workspace, tabId, agentViewMode,
  showStatusMode, showWorktreeBadges, onFocusRequest,
  surfacePaneLabel,
}: {
  sessionId: SessionId
  focusedSessionId: SessionId | null
  workspace: Workspace
  tabId: TabId
  agentViewMode: AgentViewMode
  showStatusMode: boolean
  showWorktreeBadges: boolean
  onFocusRequest?: () => void
  surfacePaneLabel?: string
}) {
  const requestFocus = useCallback(() => {
    if (onFocusRequest) onFocusRequest()
    else workspace.focusSessionInTab(tabId, sessionId)
  }, [onFocusRequest, workspace, tabId, sessionId])
  // A pane renders the session it was asked to render.
  //
  // Until #992 it could render a DIFFERENT one: in the tile grid a pane had a
  // strip of "related agent" mini-tabs (its linked agents and orchestration
  // workers), and picking one swapped that child into the parent's physical
  // tile, remembered in `WorkspaceState.gridRelatedSelections`. The grid had
  // no index, so that strip was the only way to reach a parked child. The
  // stage has an index and a per-lane strip that both list children nested
  // under their parent, and selecting one simply puts it in the lane — so
  // lanes never enabled the mini-tabs, the selection map lost its only
  // writer, and both were deleted. The strip's presentational half still
  // exists in PaneHeader/TileLeaf/AgentTerminalLeaf (prop-driven, fed nothing
  // here); stage 4 of the plan either feeds it from the pool or removes it.
  const renderedSessionId = sessionId
  const meta = workspace.state.sessions[renderedSessionId]
  const kind = meta?.kind ?? DEFAULT_PROVIDER
  const runtime = useSessionRuntime(workspace, renderedSessionId)
  // WHY a parent-owned label may override the tab-local coordinate: Dispatch
  // renders one globally ordered visible-row stream, so its D23 identity can
  // legitimately differ from this session's position inside its owning tab.
  // The surface that selected the row is the only authority for that
  // coordinate. Grid and Spotlight callers omit this value and keep the
  // established paneLabelForSession behavior.
  const paneLabel = surfacePaneLabel ??
    paneLabelForSession(workspace.state, tabId, sessionId)

  if (kind === 'terminal') {
    return (
      <TerminalLeaf
        sessionId={sessionId}
        paneLabel={paneLabel}
        focused={sessionId === focusedSessionId}
        onFocusRequest={requestFocus}
        workspace={workspace}
        showStatusMode={showStatusMode}
      />
    )
  }

  // Extension-view pane. Short-circuited BEFORE getRendererProvider(kind), which
  // throws on any non-agent kind. Every lane and Spotlight funnel through here,
  // so this one branch lights the view up everywhere. Uses `sessionId` (the
  // lane's own session) not `renderedSessionId`: the extension view is keyed to
  // its own id, not whatever agent the lane resolves to.
  if (kind === 'extension-view') {
    return (
      <ExtensionViewLeaf
        sessionId={sessionId}
        focused={sessionId === focusedSessionId}
        onFocusRequest={requestFocus}
        workspace={workspace}
      />
    )
  }

  const provider = getRendererProvider(kind)
  if (getEffectiveAgentSurfaceForSession({
    kind,
    providerRuntime: meta?.providerRuntime,
    globalMode: agentViewMode,
    override: meta?.agentViewModeOverride,
    runtime,
  }) === 'terminal') {
    return (
      <TldrPane runtime={runtime} provider={kind} identity={meta?.tldrIdentity ?? renderedSessionId} enabled={Boolean(meta?.builtInMcpDomains?.includes('tldr'))} goalEnabled={Boolean(meta?.builtInMcpDomains?.includes('goal'))}>
        {/* Goal Loop strip/overlay rides inside TldrPane's relative container;
            keyed by sessionId because the loop's actuator is the session. */}
        <GoalLoopPane sessionId={renderedSessionId} />
        <MountedAgentTerminalOwner sessionId={renderedSessionId}>
          <AgentTerminalLeaf
            sessionId={renderedSessionId}
            paneLabel={paneLabel}
            agentTitle={meta?.title}
            focused={sessionId === focusedSessionId}
            onFocusRequest={requestFocus}
            workspace={workspace}
            runtime={runtime}
            projectDir={runtime.projectDir ?? meta?.cwd ?? null}
            provider={kind}
            // The rendered branch below always received this. The terminal
            // branch didn't, which is why terminal-view panes never lit their
            // header while working (#851).
            showStatusMode={showStatusMode}
          />
        </MountedAgentTerminalOwner>
      </TldrPane>
    )
  }

  const LeafComponent = provider.TileLeaf
  return (
    <TldrPane runtime={runtime} provider={kind} identity={meta?.tldrIdentity ?? renderedSessionId} enabled={Boolean(meta?.builtInMcpDomains?.includes('tldr'))} goalEnabled={Boolean(meta?.builtInMcpDomains?.includes('goal'))}>
      <GoalLoopPane sessionId={renderedSessionId} />
      <LeafComponent
        sessionId={renderedSessionId}
        runtime={runtime}
        paneLabel={paneLabel}
        focused={sessionId === focusedSessionId}
        onFocusRequest={requestFocus}
        workspace={workspace}
        showStatusMode={showStatusMode}
        showWorktreeBadges={showWorktreeBadges}
      />
    </TldrPane>
  )
})
