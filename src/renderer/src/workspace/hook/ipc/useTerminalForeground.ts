import { useCallback, useEffect } from 'react'

import type { AppStore } from '@renderer/app-state/types'
import { emptyRuntime } from '@renderer/session-runtime/state'
import { applyTerminalForeground } from '@renderer/session-runtime/terminalForeground'
import type { WorkspaceRestoreStatus } from '@renderer/workspace/hook/persistence/useBootstrap'
import type { TerminalForegroundState } from '@shared/types/terminalForeground'

// Shell activity subscription (#865).
//
// WHY this is its own hook and not a listener inside useIpcSubscriptions: that
// hub consumes the injected SessionFeed so the phone can drive it, and its
// header forbids widening the feed for desktop-only channels. Terminal activity
// is desktop-only by design (#866): the phone never shows terminals. So it
// subscribes to window.api directly, the documented home for side channels.
//
// WHY the bridge is typeof-guarded: renderer tests and non-Electron hosts
// install only the bridge methods they need, and a missing side channel must
// degrade to "no shell activity", never crash the workspace.
export function useTerminalForeground(
  restoreStatus: WorkspaceRestoreStatus,
  setRuntimes: AppStore['setWorkspaceRuntimes'],
): void {
  const apply = useCallback((sessionId: string, state: TerminalForegroundState) => {
    setRuntimes(prev => {
      const current = prev[sessionId] ?? emptyRuntime()
      // Same ownership fence every SessionFeed channel honors: a runtime
      // quarantined after a failed recovery must not accept foreign state.
      if (current.recoveryFailureCode === 'ownership-conflict') return prev
      const next = applyTerminalForeground(current, state, Date.now())
      return next === current ? prev : { ...prev, [sessionId]: next }
    })
  }, [setRuntimes])

  useEffect(() => {
    const bridge = typeof window === 'undefined' ? undefined : window.api
    if (typeof bridge?.onTerminalForeground !== 'function') return
    return bridge.onTerminalForeground(({ sessionId, ...state }) => apply(sessionId, state))
  }, [apply])

  // WHY the snapshot waits for restore: rehydrate replaces the runtime map,
  // so a snapshot applied while restore is pending would be overwritten. Main
  // emits on change only, so without this one pull a busy dev server would read
  // idle after a renderer reload until its foreground moved again.
  const restored = restoreStatus !== 'pending'
  useEffect(() => {
    if (!restored) return
    const bridge = typeof window === 'undefined' ? undefined : window.api
    if (typeof bridge?.getTerminalForegrounds !== 'function') return
    let live = true
    void bridge.getTerminalForegrounds()
      .then(snapshot => {
        if (!live) return
        for (const [sessionId, state] of Object.entries(snapshot)) apply(sessionId, state)
      })
      .catch(() => {
        // A failed snapshot only means shells read idle until their next
        // change; nothing here is worth surfacing to the user.
      })
    return () => { live = false }
  }, [restored, apply])
}
