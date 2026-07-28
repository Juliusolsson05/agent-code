import * as React from 'react'

import { cn } from '@renderer/lib/utils'

// NumberInput — a numeric field with visible +/- steppers.
//
// WHY THIS EXISTS
//
// There were exactly two numeric inputs in the app, both raw
// `<input type="number">` relying on Chromium's native spinner arrows. Those
// arrows are roughly 8px tall, appear only on hover, sit stacked on top of each
// other, and are rendered differently on every platform. For a user driving the
// app one-handed with a mouse they are close to unusable — which made "set the
// tiled-dispatch count" a keyboard task for no reason other than that nobody
// had built the control.
//
// This is deliberately NOT a settings-registry control type. There is no
// numeric SETTING today; the need is inside dialogs. Adding a registry arm for
// a case that does not exist would be scaffolding.
//
// WHY it is not a wrapper around the shared `Input`: `Input` spreads props onto
// a bare element and has no concept of an adornment. Composing steppers around
// it would mean either a wrapper div that breaks `Input`'s own sizing, or
// prop-drilling adornment slots into a primitive that four other callers use
// happily without them.

export type NumberInputProps = {
  value: number
  onChange: (next: number) => void
  min?: number
  max?: number
  step?: number
  id?: string
  'aria-label'?: string
  autoFocus?: boolean
  className?: string
}

export function NumberInput({
  value,
  onChange,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
  step = 1,
  id,
  autoFocus,
  className,
  ...rest
}: NumberInputProps) {
  const clamp = React.useCallback(
    (next: number) => Math.min(max, Math.max(min, next)),
    [max, min],
  )

  const commit = React.useCallback(
    (next: number) => {
      // NaN guard: an empty field, a lone "-", and a pasted word all parse to
      // NaN, and clamping NaN yields NaN, which would propagate into whatever
      // consumes this value. Hold the previous value instead — the user is
      // mid-edit, not asking for garbage.
      if (Number.isNaN(next)) return
      onChange(clamp(next))
    },
    [clamp, onChange],
  )

  const atMin = value <= min
  const atMax = value >= max

  return (
    <div className={cn('flex items-stretch border border-control-border bg-control-bg', className)}>
      <button
        type="button"
        aria-label="Decrease"
        disabled={atMin}
        // Keeps focus in the field so a user can click the stepper and then
        // keep typing, and so the dialog's Enter-to-confirm still applies to
        // the field rather than re-firing this button.
        onMouseDown={event => event.preventDefault()}
        onClick={() => commit(value - step)}
        className="w-7 shrink-0 border-r border-control-border text-[13px] leading-none text-control-fg hover:bg-control-hover-bg hover:text-ink disabled:opacity-40 disabled:hover:bg-control-bg"
      >
        −
      </button>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        role="spinbutton"
        aria-valuenow={value}
        aria-valuemin={min === Number.NEGATIVE_INFINITY ? undefined : min}
        aria-valuemax={max === Number.POSITIVE_INFINITY ? undefined : max}
        value={Number.isFinite(value) ? value : ''}
        min={min === Number.NEGATIVE_INFINITY ? undefined : min}
        max={max === Number.POSITIVE_INFINITY ? undefined : max}
        step={step}
        autoFocus={autoFocus}
        onChange={event => commit(Number.parseInt(event.target.value, 10))}
        // Clamp on blur, not on every keystroke: clamping while typing makes
        // "10" impossible to enter in a 1-10 field, because the intermediate
        // "1" would be rewritten the instant the "0" arrives.
        onBlur={() => commit(clamp(value))}
        className="w-full min-w-0 bg-transparent px-2 py-2 text-center font-code text-[12px] tabular-nums text-control-fg outline-none"
        {...rest}
      />
      <button
        type="button"
        aria-label="Increase"
        disabled={atMax}
        onMouseDown={event => event.preventDefault()}
        onClick={() => commit(value + step)}
        className="w-7 shrink-0 border-l border-control-border text-[13px] leading-none text-control-fg hover:bg-control-hover-bg hover:text-ink disabled:opacity-40 disabled:hover:bg-control-bg"
      >
        +
      </button>
    </div>
  )
}
