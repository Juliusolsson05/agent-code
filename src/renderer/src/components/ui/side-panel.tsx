import * as React from 'react'

import { cn } from '@renderer/lib/utils'

/**
 * The outer shell of a docked side panel: the column that sits in the main
 * row to the right of the workspace (Git, Worktrees, Agent Status, the debug
 * panels). Pair it with `PanelHeader` for the header (#512).
 *
 * WHY a shell component: nine panels carried copies of the same class string
 * (`h-full w-[N] flex-shrink-0 border-l border-border bg-surface flex flex-col
 * overflow-hidden`), which had already drifted (one `aside` among `div`s, one
 * without the code font, one with its own border colour). The slot is one
 * thing in the window, so its chrome is one component.
 *
 * WHY width stays a className (`w-[280px]`) and not a number prop: Tailwind
 * only emits classes it sees spelled out, so a runtime `w-[${n}px]` would
 * produce no CSS. Each panel keeps its width because each was sized for its
 * content (HTML wraps badly under 540px, for one).
 *
 * WHY no z-index: side panels are in normal flow in the main row, never
 * floating. A panel that needs to float is not a side panel (RemotePanel was
 * registered here while rendering a centred dialog; it now lives with the
 * modals).
 */
export function SidePanel({
  label,
  className,
  children,
  ...props
}: React.ComponentProps<'aside'> & {
  /** The panel's name for assistive technology ("Git"); the aside is a
   *  landmark, so it needs one. */
  label: string
}) {
  return (
    <aside
      data-slot="side-panel"
      aria-label={label}
      className={cn('flex h-full flex-shrink-0 flex-col overflow-hidden border-l border-border bg-surface', className)}
      {...props}
    >
      {children}
    </aside>
  )
}
