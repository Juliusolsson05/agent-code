import { useCallback } from 'react'

import { emptyRuntime } from '../../workspaceState'
import type { SessionId } from '../../types'
import {
  assistantUuidsWithText,
  extractAssistantByUuid,
} from '../../../lib/copyAssistant'

import type { WorkspaceSetRuntimes } from '../context'
import type { WorkspaceRefs } from '../refs'

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

export function usePickerActions(
  setRuntimes: WorkspaceSetRuntimes,
  refs: WorkspaceRefs,
  showPaneToast: (sessionId: SessionId, message: string, durationMs?: number) => void,
): {
  pickerEnter: (sessionId: SessionId) => void
  pickerMove: (sessionId: SessionId, direction: -1 | 1) => void
  pickerCancel: (sessionId: SessionId) => void
  pickerConfirm: (sessionId: SessionId) => Promise<void>
} {
  const pickerEnter = useCallback(
    (sessionId: SessionId) => {
      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        if (current.assistantPicker) {
          return {
            ...prev,
            [sessionId]: { ...current, assistantPicker: null },
          }
        }
        const uuids = assistantUuidsWithText(current.entries)
        if (uuids.length === 0) return prev
        return {
          ...prev,
          [sessionId]: {
            ...current,
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
        return { ...prev, [sessionId]: { ...c, assistantPicker: null } }
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
        return { ...prev, [sessionId]: { ...c, assistantPicker: null } }
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

  return { pickerEnter, pickerMove, pickerCancel, pickerConfirm }
}
