import { useCallback, useRef, type ReactNode } from 'react'

import { useResizableSplitter } from '@renderer/features/shared/useResizableSplitter'
import { SplitHandle } from '@renderer/features/shared/SplitHandle'

type ResizableSidebarProps = {
  visible?: boolean
  widthPx: number
  onWidthChange: (widthPx: number) => void
  children: ReactNode
}

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
        hitSizePx={10}
        barSizePx={4}
      />
      {splitter.cursorLock}
    </div>
  )
}
