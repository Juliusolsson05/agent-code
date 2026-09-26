import * as React from 'react'

import { radioGroupKeyDown } from '@renderer/lib/radioGroupKeys'
import { cn } from '@renderer/lib/utils'

/**
 * A connected row of mutually exclusive choices ("All projects | Selected
 * projects", "LAN | Tunnel", "Split | Browser | Agent").
 *
 * WHY a primitive (UI pass, G-10): the sweep found seven recipes for this one
 * control. Some were separate bordered pills with an accent tint, some a
 * rounded-l/-r pair, some a row-selected fill inside a slab, and each drew
 * its selected segment differently. One look now: a single bordered group,
 * hairline separators, and the selected segment on the control-active tokens
 * (the same "on" look as the settings option cards).
 *
 * TWO SEMANTICS, chosen per use, because the keyboard contract differs:
 *   'pressed' (default) toggle buttons with `aria-pressed`, each its own Tab
 *             stop, and nothing changes until Space/Enter/click. For choices
 *             with real side effects (Remote's LAN/Tunnel starts or stops a
 *             tunnel), where selecting on arrow would fire them.
 *   'radio'   an APG radio group: one Tab stop, and arrows move AND select
 *             (the k9 contract in lib/radioGroupKeys). For cheap, reversible
 *             view choices.
 */
export type SegmentedOption<T extends string> = {
  value: T
  label: React.ReactNode
  disabled?: boolean
}

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  semantics = 'pressed',
  size = 'default',
  className,
}: {
  /** Accessible name of the group. */
  label: string
  /** null = nothing chosen yet (e.g. Remote before a transport is known). */
  value: T | null
  options: readonly SegmentedOption<T>[]
  onChange: (value: T) => void
  semantics?: 'pressed' | 'radio'
  size?: 'default' | 'sm'
  className?: string
}) {
  const radio = semantics === 'radio'
  return (
    <div
      data-slot="segmented-control"
      role={radio ? 'radiogroup' : 'group'}
      aria-label={label}
      onKeyDown={radio ? radioGroupKeyDown : undefined}
      className={cn('inline-flex flex-shrink-0 overflow-hidden rounded-control border border-control-border', className)}
    >
      {options.map((option, index) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role={radio ? 'radio' : undefined}
            aria-checked={radio ? selected : undefined}
            aria-pressed={radio ? undefined : selected}
            // Roving in radio mode: the checked segment is the one Tab stop.
            // With nothing chosen, the first segment is the stop.
            tabIndex={radio ? (selected || (value === null && index === 0) ? 0 : -1) : undefined}
            disabled={option.disabled}
            onClick={() => { if (!selected) onChange(option.value) }}
            className={cn(
              'font-code outline-none transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-50',
              size === 'sm' ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-[11px]',
              index > 0 && 'border-l border-control-border',
              selected
                ? 'bg-control-active-bg text-control-active-fg'
                : 'bg-control-bg text-control-fg hover:bg-control-hover-bg hover:text-ink',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
