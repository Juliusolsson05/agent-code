import { useEffect } from 'react'

import { useSidekickIndexStore } from '@renderer/features/sidekick/state/sidekickIndexStore'
import type { SidekickReleasedEvent } from '@shared/sidekicks/types'

/**
 * Initial fetch + push subscription for the Sidekick index, and the
 * `sidekick:released` listener (#1493).
 *
 * Mounted ONCE per window, by SidekickPanelSurface — which is always
 * rendered (it returns no panel while closed) precisely so this runs even
 * while the panel is hidden: another window can move a sidekick away from
 * this one at any time, and the row must be released when it does, open
 * panel or not. A second mount would double every broadcast handler.
 */
export function useSidekickIndexSync(onReleased: (event: SidekickReleasedEvent) => void): void {
  useEffect(() => {
    let cancelled = false
    void window.api.listSidekicks().then(view => {
      if (!cancelled) useSidekickIndexStore.getState().accept(view)
    }).catch(() => undefined)
    const unsubChanged = window.api.onSidekicksChanged(view => useSidekickIndexStore.getState().accept(view))
    const unsubReleased = window.api.onSidekickReleased(onReleased)
    return () => {
      cancelled = true
      unsubChanged()
      unsubReleased()
    }
  }, [onReleased])
}
