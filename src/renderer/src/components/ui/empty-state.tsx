import * as React from 'react'

import { cn } from '@renderer/lib/utils'

/**
 * "Nothing here" for a list or a section. One sentence, with a period.
 *
 * WHY a primitive (UI pass, G-14): the sweep found eight empty states with
 * eight layouts (py-2 to py-12, 10 to 12px, left or centred, with or without
 * a period, straight or curly quotes around the query). Two sizes cover the
 * real cases:
 *   list    the whole list or result area is empty (centred, 12px, py-8);
 *   inline  one section inside a panel is empty (left, 11px, compact).
 *
 * Pass `role="status"` when the empty state replaces live content that can
 * come back (a search), so the change is announced.
 */
export function EmptyState({
  size = 'list',
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { size?: 'list' | 'inline' }) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        'text-muted',
        size === 'list' ? 'px-3 py-8 text-center text-[12px]' : 'px-3 py-2 text-[11px]',
        className,
      )}
      {...props}
    />
  )
}
