import { focusedControlOwnsEnter } from '@renderer/components/ui/dialog-actions'
import { useListNavigation, type ListItemProps } from '@renderer/lib/useListNavigation'
import { useCallback, useEffect, useState } from 'react'
import type { KeyboardEvent } from 'react'

import type { SessionId } from '@renderer/workspace/types'

// Pure keybind state for the Pin Agents modal — split out of the
// JSX so reasoning about navigation + selection is easy to read
// without scrolling past Tailwind. Same shape as the small keybind
// hooks under workspace/tile-tree/TileLeaf/ (useComposerKeybinds, etc.).
//
// Local state, NOT workspace state, is deliberate: the modal is a
// transient draft. The reducer only sees the committed list when
// the user presses Enter. That preserves the "Escape cancels"
// invariant promised by the uiShell.pinAgentsOpen docstring — any
// half-finished selection state gets thrown away with the modal.
//
// Append-on-pin ordering matches the spec: "the order you Space
// through the rows is the order pins render in." Re-Space on an
// already-selected row removes it (and a later Space at the end of
// the list adds it back at the tail, sinking newest to the bottom).

export type PinAgentsCandidateRow = {
  sessionId: SessionId
}

export type UsePinAgentsKeybindsArgs<R extends PinAgentsCandidateRow> = {
  rows: R[]
  /** Initial selection — the set of currently-pinned sessions. */
  initialSelectedIds: SessionId[]
  /** True when the modal is mounted; false hides keybinds. */
  open: boolean
  /** Called with the final ordered selection when the user presses Enter. */
  onCommit: (ids: SessionId[]) => void
}

export type UsePinAgentsKeybindsResult = {
  selectedIds: SessionId[]
  focusedIndex: number
  setFocusedIndex: (index: number) => void
  toggle: (sessionId: SessionId) => void
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  /** Hover/click/scroll wiring for row `index` (from useListNavigation). */
  getRowProps: (index: number) => ListItemProps
}

export function usePinAgentsKeybinds<R extends PinAgentsCandidateRow>({
  rows,
  initialSelectedIds,
  open,
  onCommit,
}: UsePinAgentsKeybindsArgs<R>): UsePinAgentsKeybindsResult {
  const [selectedIds, setSelectedIds] = useState<SessionId[]>(initialSelectedIds)

  // When the modal opens we re-seed the selection. Without this, opening the
  // modal twice in a row would carry over the previous attempt's draft state
  // — closing with Escape is supposed to mean "throw the draft away," and the
  // React state is otherwise preserved whenever the component is not
  // remounted. (The highlight is re-seeded by useListNavigation's resetKey.)
  useEffect(() => {
    if (!open) return
    setSelectedIds(initialSelectedIds)
    // initialSelectedIds intentionally NOT in deps: only re-seed on
    // open transitions, not on every re-render of the parent. The
    // user editing their selection inside the modal would otherwise
    // get reset every time the workspace state advanced.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const toggle = useCallback(
    (sessionId: SessionId) => {
      setSelectedIds(prev => {
        if (prev.includes(sessionId)) {
          return prev.filter(id => id !== sessionId)
        }
        return [...prev, sessionId]
      })
    },
    [],
  )

  // Movement, Enter and Space go through the ONE list implementation
  // (lib/useListNavigation, keyboard-first plan K5). What this hook still owns
  // is the part that is Pin-specific: the ordered selection draft and what
  // Enter means (commit the draft, not "activate a row").
  //
  // jk: this dialog has no text input, so j/k are free — they were already
  // bound here before the shared hook existed, and dropping them would be a
  // regression for anyone who learned them.
  //
  // The #867 rules (a focused Cancel/Done owns its own Enter and Space) are
  // enforced inside useListNavigation now, via the same predicates.
  const nav = useListNavigation({
    count: rows.length,
    resetKey: open,
    jk: true,
    onActivate: () => onCommit(selectedIds),
    onToggle: index => {
      const row = rows[index]
      if (row) toggle(row.sessionId)
    },
  })

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      // Escape deliberately belongs to DialogContent. Keeping it here would
      // make this feature's key handler race Radix's close/focus-restoration
      // path and can call the owner twice for one key press.
      //
      // Enter with an EMPTY list still commits: useListNavigation skips
      // activation when there are no rows, but "no candidates" + Enter here
      // has always meant "save the (empty) pin list", so it is kept.
      if (rows.length === 0 && event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (focusedControlOwnsEnter(event.target)) return
        event.preventDefault()
        onCommit(selectedIds)
        return
      }
      nav.onKeyDown(event)
    },
    [nav, onCommit, rows.length, selectedIds],
  )

  return {
    selectedIds,
    focusedIndex: nav.index,
    setFocusedIndex: nav.setIndex,
    toggle,
    onKeyDown,
    getRowProps: nav.getItemProps,
  }
}
