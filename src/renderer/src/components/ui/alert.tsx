import * as React from 'react'

import { cn } from '@renderer/lib/utils'

/**
 * An inline error or warning box: the one look for "this failed" inside a
 * dialog, panel or settings row.
 *
 * WHY a primitive (UI pass, G-13): the sweep found seven recipes for the
 * same box. Some had a border but no fill, some used `bg-danger/10`
 * (bypassing the theme's `danger-soft`), one had ink-coloured text, and the
 * padding and size varied. Themes set `danger-soft` / `danger-border`
 * precisely so these read the same everywhere; hand-mixed opacities do not
 * follow a theme.
 *
 * `role="alert"` by default: these mount together with their message, and
 * an alert is announced on insertion (a polite live region that appears
 * with its text is not). Pass `role={undefined}` for a static notice.
 */
export function Alert({
  tone = 'danger',
  className,
  role = 'alert',
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { tone?: 'danger' | 'warning' }) {
  return (
    <div
      data-slot="alert"
      role={role}
      className={cn(
        'rounded-slab border px-3 py-2 text-[11px] leading-[1.5] [overflow-wrap:anywhere]',
        tone === 'danger' ? 'border-danger-border bg-danger-soft text-danger' : 'border-warning-border bg-warning-soft text-warning',
        className,
      )}
      {...props}
    />
  )
}
