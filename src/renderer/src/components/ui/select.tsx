import * as React from 'react'

import { cn } from '@renderer/lib/utils'

/**
 * A styled NATIVE <select>, on the input tokens.
 *
 * WHY native and not a custom listbox: the platform select already has
 * complete keyboard handling (arrows, type-ahead, Space/Enter to open) and
 * screen-reader support, and a focused select keeps its own Enter/Space
 * (DialogActions' focusedControlOwnsEnter, steering k4). What the app lacked
 * was ONE look (UI pass, G-11): the sweep found eight hand-styled selects on
 * three token sets (input, control, and bare `border-border bg-canvas`), two
 * radii, and several with no focus ring at all.
 *
 * Sizes follow Input/Button: default h-8 (dialogs, settings), sm h-7 (dense
 * toolbars), xs h-6 (inline in a row).
 */
const sizes = {
  default: 'h-8 px-2 text-[12px]',
  sm: 'h-7 px-2 text-[11px]',
  xs: 'h-6 px-1.5 text-[10px]',
} as const

export const Select = React.forwardRef<
  HTMLSelectElement,
  Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'> & { size?: keyof typeof sizes }
>(function Select({ className, size = 'default', ...props }, ref) {
  return (
    <select
      ref={ref}
      data-slot="select"
      className={cn(
        'min-w-0 rounded-control border border-input-border bg-input-bg font-code text-ink outline-none transition-colors',
        'focus-visible:border-input-border-focus focus-visible:ring-1 focus-visible:ring-focus-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        sizes[size],
        className,
      )}
      {...props}
    />
  )
})
