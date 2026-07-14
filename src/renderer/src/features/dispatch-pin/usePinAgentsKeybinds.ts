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
  /** Called when the user presses Escape or otherwise cancels. */
  onCancel: () => void
}

export type UsePinAgentsKeybindsResult = {
  selectedIds: SessionId[]
  focusedIndex: number
  setFocusedIndex: (index: number) => void
  toggle: (sessionId: SessionId) => void
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
}

export function usePinAgentsKeybinds<R extends PinAgentsCandidateRow>({
  rows,
  initialSelectedIds,
  open,
  onCommit,
  onCancel,
}: UsePinAgentsKeybindsArgs<R>): UsePinAgentsKeybindsResult {
  const [selectedIds, setSelectedIds] = useState<SessionId[]>(initialSelectedIds)
  const [focusedIndex, setFocusedIndex] = useState(0)

  // When the modal opens we re-seed both the selection and the
  // focused row. Without this, opening the modal twice in a row
  // would carry over the previous attempt's draft state — closing
  // with Escape is supposed to mean "throw the draft away," but
  // without re-seeding on `open` transitions the React state is
  // simply preserved across mount cycles whenever the component
  // doesn't get remounted (and as a child of a `open && ...` gate
  // in the parent, it does get remounted — but defending against
  // future refactors is cheap here).
  useEffect(() => {
    if (!open) return
    setSelectedIds(initialSelectedIds)
    setFocusedIndex(0)
    // initialSelectedIds intentionally NOT in deps: only re-seed on
    // open transitions, not on every re-render of the parent. The
    // user editing their selection inside the modal would otherwise
    // get reset every time the workspace state advanced.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Clamp focus into range when rows shrink under us (e.g. an
  // agent died while the modal is open and the parent rebuilds its
  // candidate list).
  useEffect(() => {
    setFocusedIndex(prev => {
      if (rows.length === 0) return 0
      return Math.min(prev, rows.length - 1)
    })
  }, [rows.length])

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

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        onCommit(selectedIds)
        return
      }
      if (event.key === 'ArrowDown' || (event.key === 'j' && !event.metaKey && !event.ctrlKey)) {
        event.preventDefault()
        setFocusedIndex(prev => {
          if (rows.length === 0) return 0
          return Math.min(rows.length - 1, prev + 1)
        })
        return
      }
      if (event.key === 'ArrowUp' || (event.key === 'k' && !event.metaKey && !event.ctrlKey)) {
        event.preventDefault()
        setFocusedIndex(prev => Math.max(0, prev - 1))
        return
      }
      if (event.key === ' ') {
        event.preventDefault()
        const row = rows[focusedIndex]
        if (row) toggle(row.sessionId)
        return
      }
    },
    [focusedIndex, onCancel, onCommit, rows, selectedIds, toggle],
  )

  return { selectedIds, focusedIndex, setFocusedIndex, toggle, onKeyDown }
}
