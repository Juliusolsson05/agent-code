import * as React from 'react'

import { cn } from '@renderer/lib/utils'

/**
 * The small uppercase label over a group: panel names, list sections, form
 * groups ("CHANGES", "INSTALLED", "APPEARANCE").
 *
 * WHY a primitive (UI pass, G-15): the sweep found this one idea written five
 * ways: the canonical `text-[10px] uppercase tracking-wider text-muted` (58
 * sites), `tracking-wide` (20), five different `tracking-[Nem]` values (15,
 * one of them inside DropdownMenuLabel itself), no tracking at all, and four
 * local helpers with their own copies. Each copy drifted a little, so the
 * same kind of label looked different from panel to panel.
 *
 * Renders a <div> by default; pass `as` when the label is a real heading.
 */
export function SectionLabel({
  as: Component = 'div',
  className,
  ...props
}: React.HTMLAttributes<HTMLElement> & { as?: 'div' | 'span' | 'h2' | 'h3' }) {
  return (
    <Component
      data-slot="section-label"
      className={cn('select-none text-[10px] uppercase tracking-wider text-muted', className)}
      {...props}
    />
  )
}
