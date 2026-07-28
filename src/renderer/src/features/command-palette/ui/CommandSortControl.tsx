import { useCallback, useEffect, useRef, useState } from 'react'

import {
  COMMAND_SORT_MODES,
  COMMAND_SORT_MODE_LABELS,
} from '@renderer/features/command-palette/lib/sortCommands'
import type { CommandSortMode } from '@renderer/features/command-palette/lib/sortCommands'

// The palette's browse-order picker.
//
// WHY its own file rather than another closure inside CommandPalette.tsx: that
// component is already 2100 lines, and the interesting part of this control is
// not the markup — it is the focus discipline described below, which deserves
// to be readable without scrolling past eleven palette modes to find it.
//
// WHY a popover menu and not a click-to-cycle button: four modes means up to
// three clicks to reach the one you want, and — more importantly — a cycling
// button never tells you what the other options ARE. This control exists
// specifically for the user who does not already know what the palette can do
// for them, so hiding the options behind repeated clicks would miss the point.

/**
 * THE FOCUS RULE, which is the whole difficulty here.
 *
 * The palette's search input must keep DOM focus the entire time this control
 * is used. Everything downstream assumes it: `onKeyDown` (arrows, Enter, the
 * mode ladder) is bound to the input, and typing immediately after picking a
 * sort has to work. A button that takes focus on click would silently break
 * both until the user clicked back into the field.
 *
 * `preventDefault` on `mousedown` — not a `focus()` call afterwards — is what
 * achieves that. Focus never moves in the first place, so there is no restore
 * to get wrong, no frame where the input is blurred, and nothing to sequence
 * against React's commit.
 */
function keepFocusInSearchInput(event: React.MouseEvent): void {
  event.preventDefault()
}

export function CommandSortControl({
  mode,
  onChange,
  searching,
}: {
  mode: CommandSortMode
  onChange: (mode: CommandSortMode) => void
  /** True while a query is present. The sort mode is inert then — relevance
   *  owns search ordering — so the control reports that instead of pretending
   *  to apply. See the invariant in `rankCommands`. */
  searching: boolean
}) {
  const [open, setOpen] = useState(false)
  /** Keyboard cursor within the menu. Seeded to the ACTIVE mode on open so
   *  arrowing starts from where the user already is rather than from the top. */
  const [highlighted, setHighlighted] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)

  const openMenu = useCallback(() => {
    setHighlighted(Math.max(0, COMMAND_SORT_MODES.indexOf(mode)))
    setOpen(true)
  }, [mode])

  // Close on any pointer press outside the control.
  //
  // `pointerdown` rather than `click`: a click that lands on a palette ROW
  // would otherwise run that command before the menu ever heard about it, and
  // the palette would close with the menu still mounted mid-unmount. Reacting
  // at press time closes first, in the same gesture.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  // A query appearing while the menu is open would leave a menu hanging off a
  // disabled control. Typing is the user moving on; close for them.
  useEffect(() => {
    if (searching) setOpen(false)
  }, [searching])

  const select = useCallback(
    (next: CommandSortMode) => {
      onChange(next)
      setOpen(false)
    },
    [onChange],
  )

  /**
   * All menu keyboard handling, on `document` in the CAPTURE phase.
   *
   * WHY not a React `onKeyDown` on this component's root — which is what this
   * originally was, and which was silently dead code:
   *
   * `keepFocusInSearchInput` means focus NEVER enters this subtree. The palette's
   * search input is a SIBLING of this control in the header row, so a keydown
   * originating there propagates up through the header — never through us. The
   * handler could not fire, and three keys went to the wrong place:
   *
   *   - Escape reached Radix's dismiss handler, closing the ENTIRE palette
   *     while this menu was still open.
   *   - ArrowUp/ArrowDown moved the selection in the command list *behind* the
   *     open menu, invisibly.
   *   - Enter ran `paletteCommands[selectedIndex]` — executing a command from a
   *     list the user was not even looking at.
   *
   * Capture-phase on `document` fixes all three with one mechanism, because it
   * runs before BOTH competing listeners: React 18 delegates synthetic events to
   * the root container (a descendant of `document`, so its handlers are later),
   * and Radix's dismiss layer listens on `document` in the bubble phase (later
   * still). `stopPropagation` here therefore reaches neither.
   *
   * It also means the menu is genuinely keyboard-operable, which the ARIA roles
   * on it have been promising all along.
   */
  useEffect(() => {
    if (!open) return

    const onKeyDown = (event: KeyboardEvent) => {
      const keys = ['Escape', 'ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Home', 'End']
      if (!keys.includes(event.key)) return

      // Claim the key before anything else can act on it. Every branch below
      // either consumes the key or closes the menu, so there is no case where
      // swallowing it leaves the user stuck.
      event.preventDefault()
      event.stopPropagation()

      if (event.key === 'Escape' || event.key === 'Tab') {
        setOpen(false)
        return
      }
      if (event.key === 'Enter') {
        const chosen = COMMAND_SORT_MODES[highlighted]
        if (chosen) select(chosen)
        return
      }
      if (event.key === 'Home') {
        setHighlighted(0)
        return
      }
      if (event.key === 'End') {
        setHighlighted(COMMAND_SORT_MODES.length - 1)
        return
      }
      const delta = event.key === 'ArrowDown' ? 1 : -1
      // Clamp rather than wrap: the list is four items on screen at once, so
      // wrapping buys nothing and makes it easy to shoot past the end.
      setHighlighted(current =>
        Math.min(COMMAND_SORT_MODES.length - 1, Math.max(0, current + delta)),
      )
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [open, highlighted, select])

  const label = searching ? 'Relevance' : COMMAND_SORT_MODE_LABELS[mode]

  return (
    <div ref={rootRef} className="relative flex-shrink-0">
      <button
        type="button"
        disabled={searching}
        aria-haspopup="menu"
        aria-expanded={open}
        // Spelled out rather than left to the visible label: a screen reader
        // hearing only "Relevance" has no way to know it names an ordering.
        aria-label={
          searching
            ? 'Sorted by relevance while searching'
            : `Sort commands: ${COMMAND_SORT_MODE_LABELS[mode]}`
        }
        title={
          searching
            ? 'Sorting applies when the search box is empty — results are ordered by relevance'
            : 'Change how the command list is ordered'
        }
        onMouseDown={keepFocusInSearchInput}
        onClick={() => (open ? setOpen(false) : openMenu())}
        className="
          flex items-center gap-1
          border border-control-border bg-control-bg
          px-2 py-1
          text-[11px] text-control-fg
          hover:border-control-border-hover hover:bg-control-hover-bg hover:text-ink
          disabled:cursor-default disabled:opacity-50
          disabled:hover:border-control-border disabled:hover:bg-control-bg
          disabled:hover:text-control-fg
        "
      >
        <span aria-hidden>⇅</span>
        <span>{label}</span>
        {!searching && <span aria-hidden className="text-[9px]">▾</span>}
      </button>

      {open && !searching && (
        <div
          role="menu"
          // Right-anchored: the control sits at the right edge of the header,
          // so a left-anchored menu would hang off the dialog.
          className="
            absolute right-0 top-[calc(100%+4px)] z-50
            min-w-[168px]
            border border-popover-border bg-popover-bg
            shadow-[0_8px_24px_var(--theme-shadow-color)]
          "
        >
          {COMMAND_SORT_MODES.map((candidate, index) => (
            <button
              key={candidate}
              type="button"
              role="menuitemradio"
              aria-checked={candidate === mode}
              // The keyboard cursor is state, not DOM focus — focus stays in the
              // search input by design — so the highlight has to be painted from
              // `highlighted` rather than a `:focus` style. Hover writes to the
              // same state so the two input methods share one cursor, exactly as
              // the palette's own rows do.
              onMouseEnter={() => setHighlighted(index)}
              onMouseDown={keepFocusInSearchInput}
              onClick={() => select(candidate)}
              className={`
                flex w-full items-center gap-2
                px-2 py-1.5 text-left text-[11px]
                ${
                  index === highlighted
                    ? 'bg-row-selected-bg text-row-selected-fg'
                    : 'text-ink-dim hover:bg-row-hover-bg hover:text-ink'
                }
              `}
            >
              {/* Fixed-width tick column so the labels stay aligned whether or
                  not a row is the current mode. */}
              <span aria-hidden className="w-3 flex-shrink-0 text-center">
                {candidate === mode ? '✓' : ''}
              </span>
              <span>{COMMAND_SORT_MODE_LABELS[candidate]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
