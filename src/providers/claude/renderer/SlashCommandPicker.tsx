import { useEffect, useRef } from 'react'

import type { SlashPickerState } from '../../../renderer/src/workspace/workspaceStore'

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
}

export function SlashCommandPicker({ state }: Props) {
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
        bg-surface border border-border-hi
        max-h-[240px] overflow-auto
        shadow-[0_-8px_24px_rgba(0,0,0,0.35)]
      "
      role="listbox"
      aria-label="Slash commands"
    >
      {state.items.map(item => (
        <div
          key={item.id}
          ref={item.selected ? selectedRef : undefined}
          role="option"
          aria-selected={item.selected}
          className={`
            flex items-baseline gap-3 px-3 py-1.5 font-code text-[12px]
            ${
              item.selected
                ? 'bg-accent-soft text-accent'
                : 'text-ink-dim'
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
