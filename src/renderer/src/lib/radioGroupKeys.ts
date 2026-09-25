import type { KeyboardEvent } from 'react'

/**
 * Arrow-key focus movement for a `role="radiogroup"` of `role="radio"`
 * buttons. Attach it as the GROUP's `onKeyDown`; it returns whether it handled
 * the key.
 *
 * Contract (plan K5, the Settings ruling):
 * - ←/↑ and →/↓ move focus to the previous/next radio and wrap, Home/End jump.
 * - Arrows MOVE, they do not CHOOSE. The APG pattern chooses on arrow, but
 *   several of our groups apply live (Theme, Update channel, Spotlight
 *   layout), and choosing on every arrow would flash through each option on
 *   the way to the last one. Space/Enter choose, because the radios are
 *   native buttons that already click on both. One rule for every group, so a
 *   user never has to learn which groups commit on an arrow.
 * - A modified arrow (⌥/⌘/⌃) is never ours: those are app chords (⌥↑↓ selects
 *   agents), and a radio group in the chrome must not swallow them.
 *
 * Roving tabindex (only the checked radio, or the first, is `tabIndex 0`) is
 * left to the caller, which knows what "checked" means. `focus()` still
 * reaches the `tabIndex -1` radios.
 *
 * WHY a DOM query and not an index prop: the groups differ in how they
 * render (a map over settings options, a swatch row, a hand-written pair), and
 * the focused radio is the source of truth for "where am I". Querying at
 * key time cannot go stale across re-renders the way a captured index can.
 * This was copied inline in SettingsList and ColorFlagPickerModal before it
 * was pulled out here.
 */
export function radioGroupKeyDown(event: KeyboardEvent<HTMLElement>): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false
  const radios = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]:not([disabled])'),
  ]
  const index = radios.indexOf(document.activeElement as HTMLElement)
  // Focus is not on one of OUR radios (for example a nested control), so the
  // key belongs to whatever does have focus.
  if (index < 0) return false
  const next =
    event.key === 'ArrowRight' || event.key === 'ArrowDown' ? index + 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? index - 1
        : event.key === 'Home' ? 0
          : event.key === 'End' ? radios.length - 1
            : null
  if (next === null) return false
  event.preventDefault()
  radios[(next + radios.length) % radios.length]?.focus()
  return true
}
