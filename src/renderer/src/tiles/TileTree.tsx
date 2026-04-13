import { useCallback, useRef } from 'react'

import { getRendererProvider } from '../../../providers/registry.renderer'
import { TerminalLeaf } from './TerminalLeaf'
import type { Workspace } from './workspaceStore'
import type { SessionId, TabId, TileNode } from './types'
import { collectLeaves } from './treeOps'

// TileTree — recursive renderer for a tab's binary-split tree.
//
// A leaf is a TileLeaf. A split is two TileTrees laid side-by-side (or
// stacked) with a draggable divider in between. The recursion makes
// arbitrary split nesting Just Work — the tree is literally the layout.

type Props = {
  tabId: TabId
  node: TileNode
  focusedSessionId: SessionId
  workspace: Workspace
}

export function TileTree({ tabId, node, focusedSessionId, workspace }: Props) {
  if (node.type === 'leaf') {
    return renderWorkspaceLeaf(node.sessionId, focusedSessionId, workspace, tabId)
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
        />
      }
      b={
        <TileTree
          tabId={tabId}
          node={node.b}
          focusedSessionId={focusedSessionId}
          workspace={workspace}
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
  focusedSessionId: SessionId,
  workspace: Workspace,
  tabId: TabId = workspace.state.activeTabId,
) {
  const meta = workspace.state.sessions[sessionId]
  const kind = meta?.kind ?? 'claude'

  if (kind === 'terminal') {
    return (
      <TerminalLeaf
        sessionId={sessionId}
        focused={sessionId === focusedSessionId}
        onFocusRequest={() => workspace.focusSessionInTab(tabId, sessionId)}
        workspace={workspace}
      />
    )
  }

  const provider = getRendererProvider(kind)
  const runtime = workspace.getRuntime(sessionId)
  const LeafComponent = provider.TileLeaf
  return (
    <LeafComponent
      sessionId={sessionId}
      runtime={runtime}
      focused={sessionId === focusedSessionId}
      onFocusRequest={() => workspace.focusSessionInTab(tabId, sessionId)}
      workspace={workspace}
    />
  )
}

function firstLeafId(n: TileNode): SessionId {
  return collectLeaves(n)[0]
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

      const onMove = (ev: MouseEvent) => {
        const rect = container.getBoundingClientRect()
        const rel = isVertical
          ? (ev.clientX - rect.left) / rect.width
          : (ev.clientY - rect.top) / rect.height
        workspace.setSplitRatioInTab(tabId, aSessionId, bSessionId, rel)
      }
      const onUp = () => {
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
