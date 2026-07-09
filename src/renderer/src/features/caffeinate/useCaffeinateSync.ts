import { useEffect } from 'react'
import { useCaffeinateStore } from './store'

// Root effect extracted from App.tsx (#494). Called ONCE from the
// composition root — it hydrates the store and keeps it subscribed to
// main's caffeinate:state-changed pushes. Mounting it twice would
// double-subscribe (harmless but wasteful); there is no ref-count
// because the composition root is its only intended caller.
export function useCaffeinateSync(): void {
  useEffect(() => {
    let cancelled = false
    void window.api.getCaffeinateStatus()
      .then(status => {
        if (!cancelled) useCaffeinateStore.getState().setStatus(status)
      })
      .catch(() => {
        if (!cancelled) {
          useCaffeinateStore.getState().setStatus({
            supported: false,
            active: false,
            pid: null,
            startedAt: null,
            command: [],
            message: 'Could not read caffeinate status.',
          })
        }
      })
    const off = window.api.onCaffeinateStateChanged(status => {
      useCaffeinateStore.getState().setStatus(status)
      useCaffeinateStore.getState().setMessage(status.message)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [])
}
