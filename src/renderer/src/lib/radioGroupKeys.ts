import type { KeyboardEvent } from 'react'

/**
 * Arrow-key handling for a group of roving-focus items. Attach it as the
 * GROUP's `onKeyDown`; it returns whether it handled the key.
 *
 * Two contracts, decided once for the whole app (steering k9, recorded in the
 * keyboard-first plan's Rulings):
 *
 * - `radioGroupKeyDown`, for a `role="radiogroup"`: ←/↑ and →/↓ move to the
 *   previous/next radio AND CHECK IT (the WAI-ARIA APG radio pattern; see
 *   https://www.w3.org/WAI/ARIA/apg/patterns/radio/), wrapping; Home/End jump
 *   and check. Because selection follows focus, the one Tab stop (the checked
 *   radio) is always where the user left off.
 *
 *   This REVERSES the first ruling ("arrows move, Space chooses"), which was
 *   made so a live setting such as Theme would not change on every arrow.
 *   That kept `radiogroup` semantics while breaking their promise: a screen
 *   reader user hears "radio, 2 of 6", presses an arrow, and nothing is
 *   selected. Tabbing away and back also returned to the OLD choice, not to
 *   where they had moved. Live settings that preview on arrow is how native
 *   radios behave everywhere, and every one of ours is reversible.
 *
 * - `rovingFocusKeyDown`, for a group whose items COMMIT on activation (the
 *   Color flag picker: choosing sets the flag and closes the dialog). Arrows
 *   move focus only; Enter/Space/click on the focused item commit. Such a
 *   group must NOT claim radio semantics (it is a listbox of options), and
 *   its roving Tab stop follows FOCUS, which its caller tracks.
 *
 * Shared by both: modified arrows (⌥/⌘/⌃) pass through, since those are app
 * chords (⌥↑↓ selects agents) and a group in the chrome must not swallow them.
 * Keys pressed while focus is not on one of the group's items are left alone.
 *
 * WHY a DOM query and not an index prop: the groups render differently (a map
 * over settings options, a swatch row, a hand-written pair), and the focused
 * item is the source of truth for "where am I". Querying at key time cannot go
 * stale across re-renders the way a captured index can.
 */
export function rovingFocusKeyDown(
  event: KeyboardEvent<HTMLElement>,
  itemSelector: string,
): HTMLElement | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLElement>(`${itemSelector}:not([disabled])`),
  ]
  const index = items.indexOf(document.activeElement as HTMLElement)
  if (index < 0) return null
  const next =
    event.key === 'ArrowRight' || event.key === 'ArrowDown' ? index + 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? index - 1
        : event.key === 'Home' ? 0
          : event.key === 'End' ? items.length - 1
            : null
  if (next === null) return null
  event.preventDefault()
  const target = items[(next + items.length) % items.length] ?? null
  target?.focus()
  return target
}

export function radioGroupKeyDown(event: KeyboardEvent<HTMLElement>): boolean {
  const target = rovingFocusKeyDown(event, '[role="radio"]')
  if (!target) return false
  // Check it through the radio's own click handler, so the arrow and the
  // mouse can never disagree about what choosing means. Skipped when it is
  // already checked, because a wrap onto the checked radio (a one-option
  // group) must not re-fire a live setting's side effect.
  if (target.getAttribute('aria-checked') !== 'true') target.click()
  return true
}
