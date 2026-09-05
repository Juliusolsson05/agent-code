import { memo, useMemo, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@renderer/app-state/hooks'
import { useCodexTranscriptObservationOutbox } from '@renderer/lifecycle/codexTranscriptObservationOutbox'
import { usePickerSanity } from '@renderer/workspace/hook/invalidation/effects'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { WorkspaceState } from '@renderer/workspace/types'
import { useAutoSave } from './useAutoSave'

/** Autosave invalidation belongs to the persistence service, not App's React
 * state. Typing should update one composer and its save deadline, not execute
 * the entire workspace controller just to increment an invisible counter. */
export function createDraftChanges() {
  let version = 0
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => version,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    bump: () => {
      version++
      for (const listener of listeners) listener()
    },
  }
}

const SessionRuntimeObserver = memo(function SessionRuntimeObserver({ sessionId, pickerCancel }: {
  sessionId: string
  pickerCancel: (sessionId: string) => void
}) {
  const runtime = useAppStore(state => state.workspaceRuntimes[sessionId])
  const snapshot = useMemo(() => runtime ? { [sessionId]: runtime } : {}, [runtime, sessionId])
  // Keep mutation-before-visible-surface chronology: the outbox still flushes
  // in a layout effect. A one-second timer would change forensic ordering.
  useCodexTranscriptObservationOutbox(snapshot)
  usePickerSanity(snapshot, pickerCancel)
  return null
})

export function WorkspaceRuntimeServices({ state, refs, bootstrapComplete, draftChanges, pickerCancel }: {
  state: WorkspaceState
  refs: WorkspaceRefs
  bootstrapComplete: boolean
  draftChanges: ReturnType<typeof createDraftChanges>
  pickerCancel: (sessionId: string) => void
}) {
  const ids = useAppStore(useShallow(store => Object.keys(store.workspaceRuntimes)))
  const draftVersion = useSyncExternalStore(draftChanges.subscribe, draftChanges.getSnapshot)
  useAutoSave(state, draftVersion, refs, bootstrapComplete)
  return <>{ids.map(sessionId =>
    <SessionRuntimeObserver key={sessionId} sessionId={sessionId} pickerCancel={pickerCancel} />,
  )}</>
}
