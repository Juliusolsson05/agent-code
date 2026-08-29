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
  /** Forwarded to the inner `<input>`. Dialogs need this to take mount focus
   *  back from Radix's FocusScope, which otherwise focuses the first tabbable
   *  node — one of the steppers — and does so after any child autoFocus. */
  inputRef?: React.Ref<HTMLInputElement>
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
  inputRef,
  ...rest
}: NumberInputProps) {
  const clamp = React.useCallback(
    (next: number) => Math.min(max, Math.max(min, next)),
    [max, min],
  )

  // What the user has typed, while it is not yet a committable number.
  // Non-null only mid-edit (empty field, a lone "-", or a value below `min`
  // that is a prefix of a valid one).
  //
  // WHY this exists: clamping on every keystroke makes the field unusable.
  // Typing "5" over a pre-filled "2" in a 1-10 field gives "25" -> clamped to
  // 10, silently and with nothing on screen to explain it. And the field could
  // not be cleared to retype, because an empty string parses to NaN, the
  // commit bailed, and the controlled input snapped straight back. Holding the
  // raw draft until it is a usable number fixes both.
  const [draft, setDraft] = React.useState<string | null>(null)

  const commitFromText = React.useCallback(
    (text: string) => {
      if (text.trim() === '') {
        setDraft('')
        return
      }
      const parsed = Number.parseInt(text, 10)
      if (Number.isNaN(parsed)) return
      // Only the UPPER bound is enforced per keystroke — exceeding max is
      // never a prefix of something valid, so clamping it immediately is
      // helpful rather than obstructive. A value below `min` IS a legal prefix
      // ("1" on the way to "10"), so it is held as a draft instead.
      if (parsed < min) {
        setDraft(text)
        return
      }
      setDraft(null)
      onChange(Math.min(max, parsed))
    },
    [max, min, onChange],
  )

  const commitNumber = React.useCallback(
    (next: number) => {
      if (Number.isNaN(next)) return
      setDraft(null)
      onChange(clamp(next))
    },
    [clamp, onChange],
  )

  // Resolve any half-typed draft when focus leaves. This is the only place a
  // below-min value gets clamped up, which is why the draft cannot get stuck.
  const settleDraft = React.useCallback(() => {
    if (draft === null) return
    const parsed = Number.parseInt(draft, 10)
    setDraft(null)
    onChange(clamp(Number.isNaN(parsed) ? value : parsed))
  }, [clamp, draft, onChange, value])

  // Steppers reflect the committed value, not a half-typed draft — a draft is
  // by definition below `min`, and dimming "+" while the user is mid-word
  // would be wrong.
  const atMin = draft === null && value <= min
  const atMax = draft === null && value >= max

  return (
    <div className={cn('flex items-stretch overflow-hidden rounded-control border border-control-border bg-control-bg', className)}>
      <button
        type="button"
        aria-label="Decrease"
        disabled={atMin}
        // Keeps focus in the field so a user can click the stepper and then
        // keep typing, and so the dialog's Enter-to-confirm still applies to
        // the field rather than re-firing this button.
        onMouseDown={event => event.preventDefault()}
        onClick={() => commitNumber(value - step)}
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
        value={draft ?? (Number.isFinite(value) ? String(value) : '')}
        min={min === Number.NEGATIVE_INFINITY ? undefined : min}
        max={max === Number.POSITIVE_INFINITY ? undefined : max}
        step={step}
        autoFocus={autoFocus}
        onChange={event => commitFromText(event.target.value)}
        ref={inputRef}
        onBlur={settleDraft}
        // Enter usually commits the surrounding dialog, and blur will not have
        // fired yet — so settle here too, or a half-typed draft would be
        // discarded and the dialog would commit the previous value.
        onKeyDown={event => {
          if (event.key === 'Enter') settleDraft()
        }}
        className="w-full min-w-0 bg-transparent px-2 py-2 text-center font-code text-[12px] tabular-nums text-control-fg outline-none"
        {...rest}
      />
      <button
        type="button"
        aria-label="Increase"
        disabled={atMax}
        onMouseDown={event => event.preventDefault()}
        onClick={() => commitNumber(value + step)}
        className="w-7 shrink-0 border-l border-control-border text-[13px] leading-none text-control-fg hover:bg-control-hover-bg hover:text-ink disabled:opacity-40 disabled:hover:bg-control-bg"
      >
        +
      </button>
    </div>
  )
}
