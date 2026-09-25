import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

import { focusedControlOwnsEnter, focusedControlOwnsSpace } from '@renderer/components/ui/dialog-actions'

// useListNavigation — the ONE implementation of "a highlighted row in a list
// that the keyboard moves" (keyboard-first plan K5).
//
// WHY it exists: the sweep that preceded it found 27 independent arrow-key
// implementations. They disagreed on nearly everything a user can feel:
// 14 clamped at the ends and 7 wrapped, only 5 had Home/End, none had
// PageUp/PageDown, 4 had ⌃N/⌃P, a different 4 had j/k, several forgot to
// scroll the highlight into view, and each re-derived the #862/#867 rules
// about which focused control owns Enter and Space. A user moving from the
// palette to Switch Provider to Pin Agents met three different lists.
//
// WHY a highlight INDEX and not roving DOM focus: every list dialog in the
// app keeps DOM focus on its filter input or its surface (so typing filters
// and Tab reaches the footer), which is the WAI-ARIA combobox/listbox
// `aria-activedescendant` pattern. Rows are therefore not tab stops
// (`tabIndex={-1}`) and must not steal focus on click (see getItemProps'
// onMouseDown). Roving tabindex remains right for TAB STRIPS (EditorTabs),
// which is a different widget and does not use this hook.
//
// WHY the handler returns a boolean instead of calling preventDefault
// blindly: callers compose it with their own keys (Backspace-to-go-back,
// a two-phase Enter) and need to know whether this hook consumed the event.

export type UseListNavigationOptions = {
  count: number
  /** Reset target when `resetKey` changes (e.g. the dialog re-opens). */
  initialIndex?: number
  /**
   * Any value; when it changes the highlight resets to `initialIndex`. A modal
   * instance usually stays mounted across invocations, so without a reset key
   * the previous run's highlight would preselect the next run's row.
   */
  resetKey?: unknown
  /**
   * Wrap past the ends. Default false: LISTS clamp (APG listbox), MENUS wrap
   * (APG menu) — plan decision D4. A clamped list lets a user hold ↓ to reach
   * the bottom and stay there, which is what "go to the last item" means in
   * a list; wrapping is the menu convention because menus are short cycles.
   */
  loop?: boolean
  /**
   * Accept j/k. Only for surfaces with NO text input: in a filterable picker
   * j and k are letters the user is typing.
   */
  jk?: boolean
  /** Rows per PageUp/PageDown. */
  pageSize?: number
  /** Rows the highlight skips (a disabled provider, a section header). */
  isDisabled?: (index: number) => boolean
  /** Enter on the highlight, or a click on a row. */
  onActivate?: (index: number) => void
  /** Space on the highlight, for multi-select lists. */
  onToggle?: (index: number) => void
  /** DOM id prefix for rows, used for aria-activedescendant. */
  idPrefix?: string
}

export type ListItemProps = {
  id?: string
  ref: (element: HTMLElement | null) => void
  'data-highlighted'?: true
  onMouseMove: () => void
  onMouseDown: (event: { preventDefault: () => void }) => void
  onClick: () => void
}

export type UseListNavigationResult = {
  index: number
  setIndex: (index: number) => void
  /** Returns true when the event was consumed (preventDefault already called). */
  onKeyDown: (event: ReactKeyboardEvent | KeyboardEvent) => boolean
  getItemProps: (index: number) => ListItemProps
  /** For the element that holds focus: `aria-activedescendant={activeId}`. */
  activeId: string | undefined
}

function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target instanceof HTMLTextAreaElement) return true
  if (target instanceof HTMLInputElement) {
    const type = target.type.toLowerCase()
    return type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit'
  }
  return target.isContentEditable
}

export function useListNavigation({
  count,
  initialIndex = 0,
  resetKey,
  loop = false,
  jk = false,
  pageSize = 10,
  isDisabled,
  onActivate,
  onToggle,
  idPrefix,
}: UseListNavigationOptions): UseListNavigationResult {
  const [index, setIndexState] = useState(initialIndex)
  const elements = useRef(new Map<number, HTMLElement>())
  // Only scroll when the KEYBOARD moved the highlight. Scrolling on hover
  // would drag the list under a stationary pointer, which then hovers the
  // next row, which scrolls again — the classic runaway-list bug.
  const scrollOnNextIndex = useRef(false)

  useEffect(() => {
    setIndexState(initialIndex)
    // initialIndex intentionally not a dep: it is the reset TARGET, read when
    // resetKey changes; a parent recomputing it each render must not reset
    // the highlight under the user's arrows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey])

  // Clamp when the list shrinks under the highlight (a row closed, the filter
  // narrowed). Without it Enter would activate an index that no longer exists.
  useEffect(() => {
    setIndexState(prev => (count === 0 ? 0 : Math.min(prev, count - 1)))
  }, [count])

  useEffect(() => {
    if (!scrollOnNextIndex.current) return
    scrollOnNextIndex.current = false
    // `nearest` so a row already visible does not jump; optional-call because
    // happy-dom and some embedded contexts lack scrollIntoView.
    elements.current.get(index)?.scrollIntoView?.({ block: 'nearest' })
  }, [index])

  const disabled = useCallback((i: number) => isDisabled?.(i) ?? false, [isDisabled])

  const step = useCallback(
    (from: number, delta: number): number => {
      if (count === 0) return 0
      let next = from
      // At most `count` probes, so an all-disabled list cannot spin forever.
      for (let probes = 0; probes < count; probes += 1) {
        let candidate = next + delta
        if (loop) candidate = ((candidate % count) + count) % count
        else candidate = Math.max(0, Math.min(count - 1, candidate))
        if (candidate === next) return from // clamped at an edge
        next = candidate
        if (!disabled(next)) return next
      }
      return from
    },
    [count, disabled, loop],
  )

  const moveTo = useCallback((next: number) => {
    scrollOnNextIndex.current = true
    setIndexState(next)
  }, [])

  const firstEnabled = useCallback(
    (fromEnd: boolean): number => {
      for (let n = 0; n < count; n += 1) {
        const i = fromEnd ? count - 1 - n : n
        if (!disabled(i)) return i
      }
      return 0
    },
    [count, disabled],
  )

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent | KeyboardEvent): boolean => {
      if (count === 0 && event.key !== 'Enter') return false
      const plain = !event.metaKey && !event.ctrlKey && !event.altKey
      const consume = (next: number) => {
        event.preventDefault()
        moveTo(next)
        return true
      }
      // ⌃N/⌃P: the emacs line keys macOS text fields already honour, and the
      // alias four surfaces had independently. Checked on `key` (lowercase
      // letter) with ctrl only, so ⌘N (New Agent) is never taken.
      const ctrlOnly = event.ctrlKey && !event.metaKey && !event.altKey
      if ((event.key === 'ArrowDown' && plain && !event.shiftKey) || (ctrlOnly && event.key === 'n')) {
        return consume(step(index, 1))
      }
      if ((event.key === 'ArrowUp' && plain && !event.shiftKey) || (ctrlOnly && event.key === 'p')) {
        return consume(step(index, -1))
      }
      if (jk && plain && !event.shiftKey && !isTextField(event.target)) {
        if (event.key === 'j') return consume(step(index, 1))
        if (event.key === 'k') return consume(step(index, -1))
      }
      if (event.key === 'PageDown' && plain) return consume(step(index, pageSize))
      if (event.key === 'PageUp' && plain) return consume(step(index, -pageSize))
      // Home/End belong to the caret inside a text field (a filter input), so
      // the list only takes them when focus is on the list/surface itself.
      if ((event.key === 'Home' || event.key === 'End') && plain && !isTextField(event.target)) {
        return consume(firstEnabled(event.key === 'End'))
      }
      if (event.key === 'Enter' && plain && !event.shiftKey && onActivate) {
        // A focused button owns its own Enter (#862): without this, Tab to
        // Cancel + Enter activated the highlighted row.
        if (focusedControlOwnsEnter(event.target)) return false
        if (count === 0 || disabled(index)) return false
        event.preventDefault()
        onActivate(index)
        return true
      }
      if (event.key === ' ' && plain && !event.shiftKey && onToggle) {
        // Space on a focused Cancel presses Cancel; in a filter it types a
        // space (#867).
        if (focusedControlOwnsSpace(event.target)) return false
        if (disabled(index)) return false
        event.preventDefault()
        onToggle(index)
        return true
      }
      return false
    },
    [count, disabled, firstEnabled, index, jk, moveTo, onActivate, onToggle, pageSize, step],
  )

  const getItemProps = useCallback(
    (i: number): ListItemProps => ({
      id: idPrefix ? `${idPrefix}-${i}` : undefined,
      ref: element => {
        if (element) elements.current.set(i, element)
        else elements.current.delete(i)
      },
      'data-highlighted': i === index ? true : undefined,
      // mousemove, not mouseenter: when the keyboard scrolls the list, rows
      // slide under a pointer that never moved and fire mouseenter, yanking
      // the highlight away from where the arrows put it. mousemove only fires
      // when the user actually moves the mouse.
      onMouseMove: () => {
        if (i !== index && !disabled(i)) setIndexState(i)
      },
      // Keeps DOM focus on the input/surface. Chromium focuses a clicked
      // <button> even with tabIndex=-1, after which that row would own the
      // next Enter by focusedControlOwnsEnter (see its doc comment).
      onMouseDown: event => event.preventDefault(),
      onClick: () => {
        if (disabled(i)) return
        setIndexState(i)
        onActivate?.(i)
      },
    }),
    [disabled, idPrefix, index, onActivate],
  )

  return {
    index,
    setIndex: setIndexState,
    onKeyDown,
    getItemProps,
    activeId: idPrefix && count > 0 ? `${idPrefix}-${index}` : undefined,
  }
}
