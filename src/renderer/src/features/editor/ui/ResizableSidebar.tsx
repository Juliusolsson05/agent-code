import { useCallback, useRef, type ReactNode } from 'react'

import { useResizableSplitter } from '@renderer/features/shared/useResizableSplitter'
import { SplitHandle } from '@renderer/features/shared/SplitHandle'

type ResizableSidebarProps = {
  visible?: boolean
  widthPx: number
  onWidthChange: (widthPx: number) => void
  children: ReactNode
}

// Inner editor-sidebar splitter geometry. We keep this thinner than the outer
// editor/workspace split so it reads as a sub-divider inside the editor, not a
// peer of the app-level split. The hit area stays wider than the visual bar
// because resizing the file list should not require pixel-perfect aim.
const SIDEBAR_SPLITTER_HIT_PX = 10
const SIDEBAR_SPLITTER_BAR_PX = 4

// Resizable sidebar used by editor surfaces.
//
// WHY width is owned by the caller: different editor surfaces have different
// lifetimes. Global Editor treats the file-tree width as app-session chrome;
// AI Workspace currently treats it as the same editor preference while its
// curated file list is mounted. This component should only own geometry and
// pointer plumbing. Persisting or scoping the preference belongs to the
// surface/store that understands the user's mental model.
export function ResizableSidebar({
  visible = true,
  widthPx,
  onWidthChange,
  children,
}: ResizableSidebarProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const splitter = useResizableSplitter({
    enabled: visible,
    onDrag: useCallback(
      (clientX: number) => {
        const el = containerRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        onWidthChange(clientX - rect.left)
      },
      [onWidthChange],
    ),
  })

  if (!visible) return null

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-shrink-0 overflow-hidden">
      <div className="flex-shrink-0 overflow-hidden" style={{ width: `${widthPx}px` }}>
        {children}
      </div>
      <SplitHandle
        dragging={splitter.dragging}
        onMouseDown={splitter.onMouseDown}
        hitSizePx={SIDEBAR_SPLITTER_HIT_PX}
        barSizePx={SIDEBAR_SPLITTER_BAR_PX}
        // WHY opt out of separator semantics here: these sidebars live inside
        // the Global Editor's left pane, below the app-level editor/workspace
        // separator. The old inline file-tree splitter intentionally rendered
        // as visual chrome only so assistive tech did not see it as a peer of
        // the outer split. Keep that hierarchy while sharing the DOM shape.
        exposeSeparatorRole={false}
      />
      {splitter.cursorLock}
    </div>
  )
}
