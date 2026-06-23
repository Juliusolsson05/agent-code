import { useCallback } from 'react'

import { emptyRuntime } from '@renderer/workspace/workspaceState'
import type { SessionId } from '@renderer/workspace/types'
import {
  assistantUuidsWithText,
  extractAssistantByUuid,
} from '@renderer/lib/copyAssistant'

import type { WorkspaceSetRuntimes } from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'

// ---- Copy Assistant picker actions ----
//
// pickerEnter      — toggles the picker on/off. On entry, picks
//                    the most-recent assistant entry with text.
//                    No-op (picker stays null) if the session has
//                    no assistant entries with text yet.
// pickerMove       — direction is +1 (Down → newer) or -1 (Up →
//                    older). Walks the assistantUuidsWithText
//                    list; clamps at the ends rather than wrapping
//                    (less surprising, matches macOS list pickers).
// pickerConfirm    — copies the selected entry's text to clipboard,
//                    shows a pane toast, clears the picker.
// pickerCancel     — clears the picker without copying.
//
// setCodeBlockPicker — bare setter for the Copy Code Block picker.
//                    Unlike the assistant picker above, this one has
//                    no Enter/Move logic in the store: code blocks
//                    have no transcript identity, so enumeration and
//                    navigation are DOM-driven and live in the
//                    copy-code-block feature + useKeybinds. The store
//                    only parks the current `selectedId` (or null).

export function usePickerActions(
  setRuntimes: WorkspaceSetRuntimes,
  refs: WorkspaceRefs,
  showPaneToast: (sessionId: SessionId, message: string, durationMs?: number) => void,
): {
  pickerEnter: (sessionId: SessionId) => void
  pickerMove: (sessionId: SessionId, direction: -1 | 1) => void
  pickerCancel: (sessionId: SessionId) => void
  pickerConfirm: (sessionId: SessionId) => Promise<void>
  setCodeBlockPicker: (
    sessionId: SessionId,
    picker: { selectedId: string } | null,
  ) => void
} {
  const pickerEnter = useCallback(
    (sessionId: SessionId) => {
      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        if (current.assistantPicker) {
          const renderedViewLeases = { ...current.renderedViewLeases }
          delete renderedViewLeases['copy-assistant-message']
          return {
            ...prev,
            [sessionId]: { ...current, renderedViewLeases, assistantPicker: null },
          }
        }
        const uuids = assistantUuidsWithText(current.entries)
        if (uuids.length === 0) return prev
        return {
          ...prev,
          [sessionId]: {
            ...current,
            renderedViewLeases: {
              ...current.renderedViewLeases,
              'copy-assistant-message':
                (current.renderedViewLeases['copy-assistant-message'] ?? 0) + 1,
            },
            assistantPicker: { selectedUuid: uuids[uuids.length - 1] },
          },
        }
      })
    },
    [setRuntimes],
  )

  const pickerMove = useCallback(
    (sessionId: SessionId, direction: -1 | 1) => {
      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        const picker = current.assistantPicker
        if (!picker) return prev
        const uuids = assistantUuidsWithText(current.entries)
        if (uuids.length === 0) return prev
        const idx = uuids.indexOf(picker.selectedUuid)
        if (idx === -1) {
          // Selected uuid disappeared mid-flight — snap to the
          // newest available so the user keeps a stable reference.
          return {
            ...prev,
            [sessionId]: {
              ...current,
              assistantPicker: { selectedUuid: uuids[uuids.length - 1] },
            },
          }
        }
        const nextIdx = Math.max(0, Math.min(uuids.length - 1, idx + direction))
        if (nextIdx === idx) return prev
        return {
          ...prev,
          [sessionId]: {
            ...current,
            assistantPicker: { selectedUuid: uuids[nextIdx] },
          },
        }
      })
    },
    [setRuntimes],
  )

  const pickerCancel = useCallback(
    (sessionId: SessionId) => {
      setRuntimes(prev => {
        const c = prev[sessionId]
        if (!c?.assistantPicker) return prev
        const renderedViewLeases = { ...c.renderedViewLeases }
        delete renderedViewLeases['copy-assistant-message']
        return { ...prev, [sessionId]: { ...c, renderedViewLeases, assistantPicker: null } }
      })
    },
    [setRuntimes],
  )

  const pickerConfirm = useCallback(
    async (sessionId: SessionId) => {
      const current = refs.latestRuntimesRef.current[sessionId]
      if (!current?.assistantPicker) return
      const text = extractAssistantByUuid(
        current.entries,
        current.assistantPicker.selectedUuid,
      )
      // Clear the picker first so the UI returns to normal even if
      // the clipboard write fails (rare — only with a permission
      // denial, which we surface via toast).
      setRuntimes(prev => {
        const c = prev[sessionId]
        if (!c) return prev
        const renderedViewLeases = { ...c.renderedViewLeases }
        delete renderedViewLeases['copy-assistant-message']
        return { ...prev, [sessionId]: { ...c, renderedViewLeases, assistantPicker: null } }
      })
      if (!text) {
        showPaneToast(sessionId, 'Nothing to copy')
        return
      }
      try {
        await navigator.clipboard.writeText(text)
        showPaneToast(sessionId, 'Copied assistant message')
      } catch {
        showPaneToast(sessionId, 'Clipboard write failed')
      }
    },
    [refs.latestRuntimesRef, setRuntimes, showPaneToast],
  )

  const setCodeBlockPicker = useCallback(
    (sessionId: SessionId, picker: { selectedId: string } | null) => {
      setRuntimes(prev => {
        const c = prev[sessionId]
        if (!c) return prev
        // No-op guard: avoid a runtimes object churn (and the Feed
        // re-render it triggers) when the selection didn't actually
        // change — Up/Down at a clamp end calls this with the same id.
        if ((c.codeBlockPicker?.selectedId ?? null) === (picker?.selectedId ?? null)) {
          return prev
        }
        const renderedViewLeases = { ...c.renderedViewLeases }
        if (picker && !c.codeBlockPicker) {
          // WHY the code-block picker owns a render lease:
          // code block identity lives in rendered DOM attributes, not in the
          // transcript. In Hybrid, opening the picker must keep TileLeaf
          // mounted for arrow navigation, highlighting, clipboard lookup, and
          // stale-id recovery. Clearing the picker releases the lease so Hybrid
          // can fall back to the raw terminal immediately after the copy/cancel
          // interaction finishes.
          renderedViewLeases['copy-code-block'] =
            (renderedViewLeases['copy-code-block'] ?? 0) + 1
        } else if (!picker && c.codeBlockPicker) {
          delete renderedViewLeases['copy-code-block']
        }
        return {
          ...prev,
          [sessionId]: {
            ...c,
            renderedViewLeases,
            codeBlockPicker: picker,
          },
        }
      })
    },
    [setRuntimes],
  )

  return { pickerEnter, pickerMove, pickerCancel, pickerConfirm, setCodeBlockPicker }
}
