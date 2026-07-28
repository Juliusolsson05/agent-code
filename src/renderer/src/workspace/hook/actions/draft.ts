import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { SessionId } from '@renderer/workspace/types'
import type { WorkspaceSetRuntimes } from '@renderer/workspace/hook/context'

// Draft input + image actions.
//
// Called from TileLeaf on every onChange/onKeyDown that mutates the
// composer text. Lives in runtime so it survives TileLeaf unmount
// when the user switches tabs. See SessionRuntime.draftInput for
// the reasoning.
//
// Draft version counter — bumped on every draft change so the save
// effect picks it up without watching the full runtimes object.

/**
 * Last cleared draft per session, so `Clear Composer` is reversible.
 *
 * WHY module state rather than a `SessionRuntime` field: nothing RENDERS from
 * this. Undo is a command, exactly like `undo-close`, not an affordance drawn
 * in the pane — so putting it on the runtime would add a field every reducer,
 * every debug bundle and every replay fixture carries around for a value the
 * UI never reads. Keyed by sessionId and deliberately not cleaned up on
 * session close: the map holds one short string per session the user actually
 * cleared, and a stale entry is unreachable once its session is gone.
 *
 * WHY it survives a subsequent edit rather than being dropped the moment the
 * user types again: the mistake this exists for is "I cleared, then realised."
 * Clearing the stash on the next keystroke would make undo unavailable in
 * precisely the moment the user reaches for it.
 */
const clearedDrafts = new Map<SessionId, string>()

export function useDraftActions(
  setRuntimes: WorkspaceSetRuntimes,
  updateRuntime: (sessionId: SessionId, patch: Partial<SessionRuntime>) => void,
  setDraftVersion: Dispatch<SetStateAction<number>>,
): {
  setDraftInput: (sessionId: SessionId, text: string) => void
  setDraftImages: (
    sessionId: SessionId,
    next:
      | SessionRuntime['draftImages']
      | ((prev: SessionRuntime['draftImages']) => SessionRuntime['draftImages']),
  ) => void
  clearDraft: (sessionId: SessionId) => boolean
  undoClearDraft: (sessionId: SessionId) => boolean
} {
  const setDraftInput = useCallback(
    (sessionId: SessionId, text: string) => {
      updateRuntime(sessionId, { draftInput: text })
      setDraftVersion(v => v + 1)
    },
    [setDraftVersion, updateRuntime],
  )

  const setDraftImages = useCallback(
    (
      sessionId: SessionId,
      next:
        | SessionRuntime['draftImages']
        | ((prev: SessionRuntime['draftImages']) => SessionRuntime['draftImages']),
    ) => {
      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        const draftImages =
          typeof next === 'function'
            ? next(current.draftImages)
            : next
        return {
          ...prev,
          [sessionId]: {
            ...current,
            draftImages,
          },
        }
      })
      setDraftVersion(v => v + 1)
    },
    [setDraftVersion, setRuntimes],
  )

  /**
   * Empty the composer, stashing what was there. Returns false when there was
   * nothing to clear, so the caller can stay silent instead of toasting about
   * a no-op.
   *
   * Reads the previous draft through `setRuntimes` rather than taking it as an
   * argument: the command layer has no live runtime snapshot, and passing a
   * stale draft in would stash the wrong text.
   */
  const clearDraft = useCallback(
    (sessionId: SessionId) => {
      let cleared = false
      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        if (current.draftInput.length === 0 && current.draftImages.length === 0) {
          return prev
        }
        cleared = true
        clearedDrafts.set(sessionId, current.draftInput)
        return {
          ...prev,
          [sessionId]: { ...current, draftInput: '', draftImages: [] },
        }
      })
      if (cleared) setDraftVersion(v => v + 1)
      return cleared
    },
    [setDraftVersion, setRuntimes],
  )

  /**
   * Put back the last cleared draft. Returns false when there is nothing
   * stashed — the Undo command is always visible (mirroring `undo-close`,
   * which also carries no `when` guard), so it has to no-op gracefully rather
   * than assume a stash exists.
   *
   * Deliberately does NOT restore draft images: they are large binary
   * attachments and re-inserting them silently could resurrect an image the
   * user removed on purpose in the same gesture. Text is the thing people
   * mourn losing.
   */
  const undoClearDraft = useCallback(
    (sessionId: SessionId) => {
      const stashed = clearedDrafts.get(sessionId)
      if (stashed === undefined || stashed.length === 0) return false
      clearedDrafts.delete(sessionId)
      updateRuntime(sessionId, { draftInput: stashed })
      setDraftVersion(v => v + 1)
      return true
    },
    [setDraftVersion, updateRuntime],
  )

  return { setDraftInput, setDraftImages, clearDraft, undoClearDraft }
}
