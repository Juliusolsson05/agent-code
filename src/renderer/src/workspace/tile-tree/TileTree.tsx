import { TldrPane } from '@renderer/features/tldr/TldrOverlay'
import { DEFAULT_PROVIDER } from '@shared/types/providerKind'
import { memo, useCallback } from 'react'
import { useSessionRuntime } from '@renderer/workspace/useSessionRuntime'

import { getRendererProvider } from '@providers/registry.renderer'
import type { AgentViewMode } from '@renderer/app-state/settings/types'
import { getEffectiveAgentSurfaceForSession } from '@renderer/workspace/agentDisplayMode'
import {
  buildGridRelatedAgentTabs,
  selectedGridRelatedSessionId,
} from '@renderer/workspace/gridRelatedAgents'
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
  showRelatedAgentTabs = false,
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
    showRelatedAgentTabs={showRelatedAgentTabs}
    surfacePaneLabel={surfacePaneLabel}
  />
}

// The subscription belongs below the recursive layout and above provider/view
// selection: a runtime can change Hybrid's surface, but another session's
// output must not traverse this pane or recreate any terminal callbacks.
const WorkspaceLeaf = memo(function WorkspaceLeaf({
  sessionId, focusedSessionId, workspace, tabId, agentViewMode,
  showStatusMode, showWorktreeBadges, onFocusRequest, showRelatedAgentTabs,
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
  showRelatedAgentTabs: boolean
  surfacePaneLabel?: string
}) {
  const requestFocus = useCallback(() => {
    if (onFocusRequest) onFocusRequest()
    else workspace.focusSessionInTab(tabId, sessionId)
  }, [onFocusRequest, workspace, tabId, sessionId])
  const relatedTabs = showRelatedAgentTabs
    ? buildGridRelatedAgentTabs(workspace.state, tabId, sessionId)
    : []
  const selectedSessionId = showRelatedAgentTabs
    ? selectedGridRelatedSessionId(workspace.state, tabId, sessionId) ?? sessionId
    : sessionId
  const renderedSessionId = workspace.state.sessions[selectedSessionId] ? selectedSessionId : sessionId
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
  // throws on any non-agent kind — the single edit that lights this up in grid,
  // both dispatch layouts, spotlight, and tile-tabs at once, because they all funnel
  // here. Uses `sessionId` (the physical leaf) not `renderedSessionId`: an extension
  // pane has no related-agent tab selection.
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
            // #858: same related-agent identity the rendered branch below
            // passes to LeafComponent, so a persisted related selection that
            // lands here (raw-terminal surface) is named in the status row
            // instead of silently swapping which agent's TUI this pane shows.
            ownerSessionId={sessionId}
            relatedAgentTabs={relatedTabs}
            onSelectRelatedSession={(nextSessionId: SessionId) => {
              workspace.selectGridRelatedSession(sessionId, nextSessionId)
              workspace.focusSessionInTab(tabId, sessionId)
            }}
          />
        </MountedAgentTerminalOwner>
      </TldrPane>
    )
  }

  const LeafComponent = provider.TileLeaf
  return (
    <TldrPane runtime={runtime} provider={kind} identity={meta?.tldrIdentity ?? renderedSessionId} enabled={Boolean(meta?.builtInMcpDomains?.includes('tldr'))} goalEnabled={Boolean(meta?.builtInMcpDomains?.includes('goal'))}>
      <LeafComponent
        sessionId={renderedSessionId}
        runtime={runtime}
        paneLabel={paneLabel}
        focused={sessionId === focusedSessionId}
        onFocusRequest={requestFocus}
        workspace={workspace}
        showStatusMode={showStatusMode}
        showWorktreeBadges={showWorktreeBadges}
        ownerSessionId={sessionId}
        relatedAgentTabs={relatedTabs}
        selectedRelatedSessionId={renderedSessionId}
        onSelectRelatedSession={(nextSessionId: SessionId) => {
          workspace.selectGridRelatedSession(sessionId, nextSessionId)
          workspace.focusSessionInTab(tabId, sessionId)
        }}
      />
    </TldrPane>
  )
})
