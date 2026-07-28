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
  const rootRef = useRef<HTMLDivElement>(null)

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

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== 'Escape') return
    // Escape must close the MENU without closing the palette. The Dialog's
    // `onEscapeKeyDown` owns a back-out ladder (sub-mode → command list →
    // dismiss), and letting this key reach it would skip a rung — press Escape
    // to dismiss a menu, lose your whole sub-mode.
    event.preventDefault()
    event.stopPropagation()
    setOpen(false)
  }, [])

  const label = searching ? 'Relevance' : COMMAND_SORT_MODE_LABELS[mode]

  return (
    <div ref={rootRef} className="relative flex-shrink-0" onKeyDown={onKeyDown}>
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
        onClick={() => setOpen(current => !current)}
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
          {COMMAND_SORT_MODES.map(candidate => (
            <button
              key={candidate}
              type="button"
              role="menuitemradio"
              aria-checked={candidate === mode}
              onMouseDown={keepFocusInSearchInput}
              onClick={() => select(candidate)}
              className={`
                flex w-full items-center gap-2
                px-2 py-1.5 text-left text-[11px]
                ${
                  candidate === mode
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
