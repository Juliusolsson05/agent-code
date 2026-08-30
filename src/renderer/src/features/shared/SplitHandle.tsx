import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react'

type SplitHandleProps = {
  dragging: boolean
  onMouseDown: (event: MouseEvent) => void
  hitSizePx?: number
  barSizePx?: number
  exposeSeparatorRole?: boolean
  className?: string
  style?: CSSProperties
  label?: string
  valueNow?: number
  valueMin?: number
  valueMax?: number
  onKeyboardDelta?: (delta: number) => void
  /** 'vertical' (default) is a left/right divider between columns;
   *  'horizontal' is a top/bottom divider between stacked rows. */
  orientation?: 'vertical' | 'horizontal'
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
  exposeSeparatorRole = true,
  className = '',
  style,
  label,
  valueNow,
  valueMin,
  valueMax,
  onKeyboardDelta,
  orientation = 'vertical',
}: SplitHandleProps) {
  const horizontal = orientation === 'horizontal'
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onKeyboardDelta) return
    const [back, forward] = horizontal
      ? ['ArrowUp', 'ArrowDown']
      : ['ArrowLeft', 'ArrowRight']
    if (event.key !== back && event.key !== forward) return
    event.preventDefault()
    onKeyboardDelta(event.key === back ? -1 : 1)
  }
  return (
    <div
      role={exposeSeparatorRole ? 'separator' : undefined}
      // ARIA orientation names the separator's own axis, which is the
      // OPPOSITE of the axis it moves along: a divider between stacked rows is
      // itself a horizontal line.
      aria-orientation={exposeSeparatorRole ? (horizontal ? 'horizontal' : 'vertical') : undefined}
      aria-label={exposeSeparatorRole ? label : undefined}
      aria-valuenow={exposeSeparatorRole ? valueNow : undefined}
      aria-valuemin={exposeSeparatorRole ? valueMin : undefined}
      aria-valuemax={exposeSeparatorRole ? valueMax : undefined}
      tabIndex={exposeSeparatorRole && onKeyboardDelta ? 0 : undefined}
      onKeyDown={onKeyDown}
      onMouseDown={onMouseDown}
      className={`relative flex-shrink-0 ${
        horizontal ? 'cursor-row-resize' : 'cursor-col-resize'
      } select-none outline-none focus-visible:ring-1 focus-visible:ring-focus-ring ${className}`}
      style={horizontal ? { height: `${hitSizePx}px`, ...style } : { width: `${hitSizePx}px`, ...style }}
    >
      <div
        className={`absolute ${
          horizontal ? 'top-1/2 left-0 w-full -translate-y-1/2' : 'left-1/2 top-0 h-full -translate-x-1/2'
        } ${dragging ? 'bg-accent' : 'bg-border'} transition-colors`}
        style={horizontal ? { height: `${barSizePx}px` } : { width: `${barSizePx}px` }}
      />
    </div>
  )
}
