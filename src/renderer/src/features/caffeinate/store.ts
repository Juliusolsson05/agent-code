import { create } from 'zustand'
import type { CaffeinateStatus } from '@preload/index'

// Caffeinate state was two App.tsx-local useStates (#494). It gets its
// own feature store because THREE unrelated consumers need it — the
// settings-bar button, the command palette (active/supported flags +
// toggle), and the toast overlay — and none of them should have to meet
// in a shared parent to see the same status.
//
// Source of truth is main (caffeinate IPC); this store is a mirror
// hydrated by useCaffeinateSync. `message` is transient UI feedback
// (auto-dismissed by the toast surface), `status` is durable.
type CaffeinateState = {
  status: CaffeinateStatus | null
  message: string | null
  setStatus: (status: CaffeinateStatus) => void
  setMessage: (message: string | null) => void
  dismissMessage: () => void
  toggle: () => Promise<void>
}

export const useCaffeinateStore = create<CaffeinateState>()(set => ({
  status: null,
  message: null,
  setStatus: status => set({ status }),
  setMessage: message => set({ message }),
  dismissMessage: () => set({ message: null }),
  toggle: async () => {
    try {
      const result = await window.api.toggleCaffeinate()
      set({ status: result.status, message: result.message })
    } catch (err) {
      set({ message: err instanceof Error ? err.message : 'Could not toggle caffeinate.' })
    }
  },
}))
