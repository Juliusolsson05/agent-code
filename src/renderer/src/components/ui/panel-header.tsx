import * as React from 'react'

import { Button } from '@renderer/components/ui/button'
import { SectionLabel } from '@renderer/components/ui/section-label'
import { cn } from '@renderer/lib/utils'

/**
 * The header of a docked side panel (Git, Worktrees, AI Workspace, Agent
 * Status): its name, an optional second line, its actions, and one close.
 *
 * WHY (UI pass, G-26): the four panels drew four close controls (a 16px ×, a
 * 14px ×, a 14px × with NO accessible name, and a bordered word "close"),
 * lowercase text-link actions ("copy", "refresh", "delete"), and three header
 * layouts. Panels that sit in the same slot of the window should read as one
 * family, and every close must have a name a screen reader can say.
 */
export function PanelHeader({
  label,
  title,
  actions,
  onClose,
  closeLabel,
  className,
}: {
  /** The panel's name, shown as a SectionLabel ("Git"). */
  label: string
  /** Optional second line under the name (the agent or workspace shown). */
  title?: React.ReactNode
  /** Header actions: `<Button variant="ghost" size="xs">`, left of close. */
  actions?: React.ReactNode
  onClose: () => void
  /** Accessible name of the close button; defaults to "Close <label>". */
  closeLabel?: string
  className?: string
}) {
  return (
    <div
      data-slot="panel-header"
      className={cn('flex flex-shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2', className)}
    >
      <div className="min-w-0">
        <SectionLabel>{label}</SectionLabel>
        {title ? <div className="truncate text-[11px] font-medium text-ink">{title}</div> : null}
      </div>
      <div className="flex flex-shrink-0 items-center gap-1">
        {actions}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={closeLabel ?? `Close ${label}`}
          onClick={onClose}
          className="px-1.5 text-[14px] leading-none"
        >
          <span aria-hidden="true">×</span>
        </Button>
      </div>
    </div>
  )
}
