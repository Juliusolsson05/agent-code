import type { CSSProperties, MouseEvent } from 'react'

type SplitHandleProps = {
  dragging: boolean
  onMouseDown: (event: MouseEvent) => void
  hitSizePx?: number
  barSizePx?: number
  className?: string
  style?: CSSProperties
}

// Shared vertical splitter handle.
//
// WHY this is a component rather than more inline JSX beside each
// `useResizableSplitter` call: the drag mechanics were already shared, but the
// visual separator DOM was still copied between Global Editor and Dispatch.
// That copy/paste is exactly how AI Workspace ended up with a fixed sidebar:
// the usable resizing primitive existed, but adding the visual handle still
// required re-deriving the same hit-area/bar structure. Keeping the handle next
// to the shared drag hook makes "add a resizable sidebar" one small composition
// step instead of another local splitter implementation.
export function SplitHandle({
  dragging,
  onMouseDown,
  hitSizePx = 10,
  barSizePx = 4,
  className = '',
  style,
}: SplitHandleProps) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onMouseDown={onMouseDown}
      className={`relative flex-shrink-0 cursor-col-resize select-none ${className}`}
      style={{ width: `${hitSizePx}px`, ...style }}
    >
      <div
        className={`absolute left-1/2 top-0 h-full -translate-x-1/2 ${
          dragging ? 'bg-accent' : 'bg-border'
        } transition-colors`}
        style={{ width: `${barSizePx}px` }}
      />
    </div>
  )
}
