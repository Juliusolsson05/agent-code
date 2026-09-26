import { useEffect, useRef } from 'react'

import type { SlashPickerState } from '@shared/sessionFeed/types'

// SlashCommandPicker — React rendering of the slash command dropdown.
//
// Purely presentational. Takes picker state from the parser (main
// process detects it from the Terminal buffer, ships over IPC) and
// renders it as a dropdown above the composer.
//
// Selection, filtering, and navigation all happen in CC — we just
// mirror what CC says is on screen. When the user presses Up/Down,
// TileLeaf forwards the key to the PTY, CC updates its state,
// detectSlashPicker picks up the new selection from the next screen
// snapshot, and this component re-renders with the new highlight.
//
// This is the whole reason the parser lives in main with Terminal
// access: if we tried to manage selection state in the renderer, we'd
// have to either replicate CC's 1384-line useTypeahead logic or
// accept permanent drift between our state and CC's. Instead we just
// read CC's state out of the cell attributes and display it.

type Props = {
  state: SlashPickerState
  /** DOM id of the listbox. The composer textarea points at it (aria-controls)
   *  and at the selected option (aria-activedescendant, via slashOptionId). */
  id?: string
}

/**
 * The option's DOM id. Built from the INDEX, not `item.id`: CC's ids are
 * command names ("/review", "mcp:foo") that are not safe id tokens, and the
 * composer only needs "which row is highlighted", which the index answers.
 */
export function slashOptionId(listId: string, index: number): string {
  return `${listId}-option-${index}`
}

/**
 * The id the composer should expose as aria-activedescendant, or undefined
 * when no row is highlighted or the list is closed.
 *
 * WHY the composer and not the listbox carries it (plan k2 invariant):
 * aria-activedescendant is only honoured on the element that holds DOM focus,
 * and focus never leaves the textarea while CC's picker is open. Every key is
 * forwarded to the PTY and CC moves the highlight. Before this the listbox was
 * never focused, so a screen reader heard nothing as the highlight moved.
 */
export function slashActiveDescendant(state: SlashPickerState | null, listId: string): string | undefined {
  if (!state?.visible) return undefined
  const index = state.items.findIndex(item => item.selected)
  return index < 0 ? undefined : slashOptionId(listId, index)
}

export function SlashCommandPicker({ state, id }: Props) {
  // Scroll the selected item into view when it changes. Autoscroll is
  // per-render (no transition) so it feels tight when arrowing
  // through a long picker.
  const selectedRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [state])

  if (!state.visible || state.items.length === 0) return null

  return (
    <div
      className="
        absolute left-0 right-0 bottom-full mb-1 z-50
        bg-popover-bg border border-popover-border rounded-float p-1
        max-h-[240px] overflow-auto
        shadow-[0_-8px_24px_var(--theme-shadow-color)]
      "
      // Popover tokens + theme shadow, the same as DropdownMenu. The hard-coded
      // rgba shadow was a black smear on light themes.
      id={id}
      role="listbox"
      aria-label="Slash commands"
    >
      {state.items.map((item, index) => (
        <div
          key={item.id}
          id={id ? slashOptionId(id, index) : undefined}
          ref={item.selected ? selectedRef : undefined}
          role="option"
          aria-selected={item.selected}
          // T7 row selection: the same selected-row fill and accent rail as
          // every other list in the app (it was an accent-tinted text colour,
          // a third "selected" look).
          className={`
            flex items-baseline gap-3 rounded-control border-l-2 px-3 py-1.5 font-code text-[12px]
            ${
              item.selected
                ? 'border-l-accent bg-row-selected-bg text-ink'
                : 'border-l-transparent text-ink-dim'
            }
          `}
        >
          <span
            className={`
              flex-shrink-0 w-[180px] truncate
              ${item.selected ? 'font-semibold' : ''}
            `}
          >
            {item.label}
          </span>
          <span className="flex-1 truncate text-muted">
            {item.description}
          </span>
        </div>
      ))}
    </div>
  )
}
