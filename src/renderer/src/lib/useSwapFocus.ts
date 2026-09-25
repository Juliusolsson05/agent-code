import { useLayoutEffect, useRef } from 'react'

/**
 * Carry keyboard focus across a control swap.
 *
 * Several surfaces toggle by REPLACING the pressed control with another one:
 * - the feed's "… +N lines (show all)" becomes a "collapse" at the end of the
 *   output;
 * - a code block's "view paged content" becomes its pager;
 * - the autosave-off banner's Hide becomes a corner chip.
 * The pressed button unmounts, so focus falls to <body>. The next Tab then
 * starts again from the top of the document, and a keyboard user loses their
 * place in a long transcript (ledger G-35 / G-36).
 *
 * Call `beforeSwap(scope)` in the handler that flips the state, with the
 * element whose focus should be carried: the pressed button, or a whole
 * banner for a timer-driven swap. Focus moves to `counterpartRef` after the
 * swap ONLY if it was inside `scope`. A swap the user did not cause (a
 * timer, a re-render) must never take the caret out of a composer.
 *
 * `options.preventScroll` is for a counterpart that sits far away. Expanding
 * a long output puts "collapse" at its end, and following focus there would
 * throw the reader to the bottom of what they just opened.
 *
 * The swap may be ASYNC. The goal-loop strip's Pause becomes Resume only when
 * main reports the new phase back. So the carry happens only if focus is
 * still unowned (<body>) when the swap lands. If the user moved on in the
 * meantime, their new focus wins. For a synchronous swap the pressed control
 * has just been removed, so focus is always unowned at that point.
 *
 * `counterpartRef` may point at a CONTAINER when the next control depends on
 * the new state (the goal-loop strip's controls). Its first enabled button
 * or tab stop then takes focus.
 *
 * A layout effect, not a passive one: focus lands before paint, so there is
 * no frame where <body> owns focus and a document-level router (type-to-
 * focus) could claim the next key.
 */
const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function useSwapFocus<T extends HTMLElement = HTMLButtonElement>(swapKey: unknown) {
  const counterpartRef = useRef<T>(null)
  const pending = useRef<FocusOptions | null>(null)

  const beforeSwap = (scope: Element | null | undefined, options: FocusOptions = {}) => {
    pending.current = scope?.contains(document.activeElement) ? options : null
  }

  useLayoutEffect(() => {
    const options = pending.current
    if (!options) return
    pending.current = null
    const active = document.activeElement
    if (active && active !== document.body) return
    const el = counterpartRef.current
    if (!el) return
    const target = el.matches(FOCUSABLE) ? el : el.querySelector<HTMLElement>(FOCUSABLE)
    target?.focus(options)
  }, [swapKey])

  return { counterpartRef, beforeSwap }
}
