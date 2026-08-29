import { DEFAULT_PROVIDER } from '@shared/types/providerKind'
import { useCallback, useRef } from 'react'

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
import type { SessionId, TabId, TileNode } from '@renderer/workspace/types'
import { paneLabelForSession } from '@renderer/workspace/tile-tree/paneLabels'

// TileTree — recursive renderer for a tab's binary-split tree.
//
// A leaf is a TileLeaf. A split is two TileTrees laid side-by-side (or
// stacked) with a draggable divider in between. The recursion makes
// arbitrary split nesting Just Work — the tree is literally the layout.

type Props = {
  tabId: TabId
  node: TileNode
  focusedSessionId: SessionId | null
  workspace: Workspace
  agentViewMode: AgentViewMode
  showStatusMode?: boolean
  showWorktreeBadges?: boolean
}

export function TileTree({
  tabId,
  node,
  focusedSessionId,
  workspace,
  agentViewMode,
  showStatusMode = true,
  showWorktreeBadges = true,
}: Props) {
  if (node.type === 'leaf') {
    return renderWorkspaceLeaf(
      node.sessionId,
      focusedSessionId,
      workspace,
      tabId,
      agentViewMode,
      showStatusMode,
      showWorktreeBadges,
      undefined,
      true,
    )
  }

  return (
    <SplitContainer
      direction={node.direction}
      ratio={node.ratio}
      a={
        <TileTree
          tabId={tabId}
          node={node.a}
          focusedSessionId={focusedSessionId}
          workspace={workspace}
          agentViewMode={agentViewMode}
          showStatusMode={showStatusMode}
          showWorktreeBadges={showWorktreeBadges}
        />
      }
      b={
        <TileTree
          tabId={tabId}
          node={node.b}
          focusedSessionId={focusedSessionId}
          workspace={workspace}
          agentViewMode={agentViewMode}
          showStatusMode={showStatusMode}
          showWorktreeBadges={showWorktreeBadges}
        />
      }
      // Resize dragging needs to know which sessions to update the
      // ratio between. We pick the first leaf on each side as the
      // identity for this split.
      aSessionId={firstLeafId(node.a)}
      bSessionId={firstLeafId(node.b)}
      tabId={tabId}
      workspace={workspace}
    />
  )
}

export function renderWorkspaceLeaf(
  sessionId: SessionId,
  focusedSessionId: SessionId | null,
  workspace: Workspace,
  tabId: TabId = workspace.state.activeTabId,
  agentViewMode: AgentViewMode = 'agent',
  showStatusMode = true,
  showWorktreeBadges = true,
  onFocusRequest: () => void = () => workspace.focusSessionInTab(tabId, sessionId),
  showRelatedAgentTabs = false,
  surfacePaneLabel?: string,
) {
  const relatedTabs = showRelatedAgentTabs
    ? buildGridRelatedAgentTabs(workspace.state, tabId, sessionId)
    : []
  const selectedSessionId = showRelatedAgentTabs
    ? selectedGridRelatedSessionId(workspace.state, tabId, sessionId) ?? sessionId
    : sessionId
  const renderedSessionId = workspace.state.sessions[selectedSessionId] ? selectedSessionId : sessionId
  const meta = workspace.state.sessions[renderedSessionId]
  const kind = meta?.kind ?? DEFAULT_PROVIDER
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
        onFocusRequest={onFocusRequest}
        workspace={workspace}
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
        onFocusRequest={onFocusRequest}
        workspace={workspace}
      />
    )
  }

  const provider = getRendererProvider(kind)
  const runtime = workspace.getRuntime(renderedSessionId)
  if (getEffectiveAgentSurfaceForSession({
    kind,
    globalMode: agentViewMode,
    override: meta?.agentViewModeOverride,
    runtime,
  }) === 'terminal') {
    return (
      <MountedAgentTerminalOwner sessionId={renderedSessionId}>
        <AgentTerminalLeaf
          sessionId={renderedSessionId}
          paneLabel={paneLabel}
          agentTitle={meta?.title}
          focused={sessionId === focusedSessionId}
          onFocusRequest={onFocusRequest}
          workspace={workspace}
          runtime={runtime}
          projectDir={runtime.projectDir ?? meta?.cwd ?? null}
          provider={kind}
        />
      </MountedAgentTerminalOwner>
    )
  }

  const LeafComponent = provider.TileLeaf
  return (
    <LeafComponent
      sessionId={renderedSessionId}
      runtime={runtime}
      paneLabel={paneLabel}
      focused={sessionId === focusedSessionId}
      onFocusRequest={onFocusRequest}
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
  )
}

function firstLeafId(n: TileNode): SessionId {
  let current = n
  while (current.type !== 'leaf') current = current.a
  return current.sessionId
}

// ---------------------------------------------------------------------------
// SplitContainer — CSS flex with a draggable divider.
// ---------------------------------------------------------------------------

type SplitProps = {
  tabId: TabId
  direction: 'vertical' | 'horizontal'
  ratio: number
  a: React.ReactNode
  b: React.ReactNode
  aSessionId: SessionId
  bSessionId: SessionId
  workspace: Workspace
}

function SplitContainer({
  direction,
  ratio,
  a,
  b,
  aSessionId,
  bSessionId,
  tabId,
  workspace,
}: SplitProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  // vertical split = side-by-side (flex-row), divider is a vertical bar
  // that resizes horizontally. horizontal split = stacked (flex-col),
  // divider is a horizontal bar that resizes vertically.
  const isVertical = direction === 'vertical'
  const flexDir = isVertical ? 'flex-row' : 'flex-col'
  const cursor = isVertical ? 'cursor-col-resize' : 'cursor-row-resize'
  const dividerDims = isVertical ? 'w-[3px] h-full' : 'h-[3px] w-full'

  const aFlex = { flexBasis: `${ratio * 100}%` }
  const bFlex = { flexBasis: `${(1 - ratio) * 100}%` }

  // Drag handler: measure the container and map mouse position → new ratio.
  // Uses document-level listeners so dragging past the divider edge still
  // works even if the mouse leaves the container bounds.
  const onDividerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const container = containerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      let frame: number | null = null
      let pendingRatio: number | null = null
      let lastSentRatio = ratio

      const flush = () => {
        frame = null
        if (pendingRatio === null) return
        const nextRatio = pendingRatio
        pendingRatio = null
        // WHY a tiny epsilon matters here: pointermove fires far more often
        // than CSS flex-basis visibly changes, and many adjacent events clamp
        // to the same effective split ratio. Skipping no-op-ish commits avoids
        // rewriting workspace state, re-rendering every pane, and triggering
        // terminal ResizeObservers for movements that cannot affect layout.
        if (Math.abs(nextRatio - lastSentRatio) < 0.001) return
        lastSentRatio = nextRatio
        workspace.setSplitRatioInTab(tabId, aSessionId, bSessionId, nextRatio)
      }

      const onMove = (ev: MouseEvent) => {
        pendingRatio = isVertical
          ? (ev.clientX - rect.left) / rect.width
          : (ev.clientY - rect.top) / rect.height
        if (frame === null) frame = requestAnimationFrame(flush)
      }
      const onUp = () => {
        if (frame !== null) {
          cancelAnimationFrame(frame)
          frame = null
        }
        flush()
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [aSessionId, bSessionId, isVertical, tabId, workspace],
  )

  return (
    <div
      ref={containerRef}
      className={`flex ${flexDir} w-full h-full min-h-0 min-w-0`}
    >
      <div style={aFlex} className="min-h-0 min-w-0 overflow-hidden">
        {a}
      </div>
      <div
        role="separator"
        aria-orientation={isVertical ? 'vertical' : 'horizontal'}
        className={`${dividerDims} ${cursor} bg-border hover:bg-accent transition-colors flex-shrink-0`}
        onMouseDown={onDividerMouseDown}
      />
      <div style={bFlex} className="min-h-0 min-w-0 overflow-hidden">
        {b}
      </div>
    </div>
  )
}
