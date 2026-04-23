import { useCallback, type Dispatch, type SetStateAction } from 'react'

import { emptyRuntime, type SessionRuntime } from '@renderer/workspace/workspaceState'
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

  return { setDraftInput, setDraftImages }
}
