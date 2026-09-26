import * as React from 'react'

import { radioGroupKeyDown } from '@renderer/lib/radioGroupKeys'
import { cn } from '@renderer/lib/utils'

/**
 * A radio group drawn as cards: each choice has a label and an optional
 * one-line description (Theme, Update Channel, CLI update behaviour, …).
 *
 * WHY a primitive (UI pass, G-17): SettingsList had the complete version (APG
 * radio semantics, roving Tab stop, focus ring, rounded corners). Two rows
 * outside it copied only the LOOK. Update Channel announced itself as toggle
 * buttons, CLI update behaviour announced no state at all, both were square,
 * and neither showed focus. One component means the keyboard contract and
 * the look cannot drift apart again.
 *
 * Keyboard (steering k9, lib/radioGroupKeys): one Tab stop (the checked card,
 * or the first when none is), and arrows move AND choose. Every setting behind
 * these cards is reversible, and arrowing through Theme previews each theme,
 * as native radios do.
 */
export type OptionCard<T extends string> = {
  value: T
  label: React.ReactNode
  description?: React.ReactNode
}

export function OptionCards<T extends string>({
  label,
  value,
  options,
  onChange,
  columns = 1,
  className,
}: {
  label: string
  value: T | null
  options: readonly OptionCard<T>[]
  onChange: (value: T) => void
  columns?: number
  className?: string
}) {
  const anyActive = options.some(option => option.value === value)
  return (
    <div
      data-slot="option-cards"
      role="radiogroup"
      aria-label={label}
      className={cn('grid gap-1.5', className)}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      onKeyDown={radioGroupKeyDown}
    >
      {options.map((option, index) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active || (!anyActive && index === 0) ? 0 : -1}
            onClick={() => { if (!active) onChange(option.value) }}
            className={cn(
              'rounded-control border px-3 py-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-focus-ring',
              active
                ? 'border-control-active-bg bg-control-active-bg text-control-active-fg'
                : 'border-control-border bg-control-bg text-control-fg hover:border-control-border-hover hover:bg-control-hover-bg hover:text-ink',
            )}
          >
            <div className="text-[11px]">{option.label}</div>
            {option.description ? (
              <div className={cn('mt-1 text-[10px]', active ? 'text-control-active-fg/80' : 'text-muted')}>
                {option.description}
              </div>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
