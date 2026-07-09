import { useEffect, useRef } from 'react'
import {
  AUTO_DEBUG_BUNDLE_INTERVAL_MS,
  autosaveActiveAgentDebugBundles,
} from '@renderer/features/debug/saveDebugBundle'
import { useAppStore } from '@renderer/app-state/hooks'
import type { Workspace } from '@renderer/workspace/workspaceStore'

// Root effect extracted from App.tsx (#494): aggressive debug
// persistence — periodic autosave of active-agent debug bundles.
export function useDebugAutosave(workspace: Workspace): void {
  // Ref mirror so the interval closure always reads the CURRENT
  // workspace without the effect re-arming (and re-baselining) on every
  // render — the interval must run on wall-clock cadence, not render
  // cadence.
  const workspaceRef = useRef(workspace)
  useEffect(() => {
    workspaceRef.current = workspace
  }, [workspace])

  const enabled = useAppStore(state => state.settings.aggressiveDebugPersistence)
  useEffect(() => {
    if (!enabled) return

    let disposed = false
    let inFlight = false

    const saveAll = (reason: 'autosave-enabled' | 'autosave-interval' | 'autosave-beforeunload') => {
      if (inFlight && reason !== 'autosave-beforeunload') return
      inFlight = true
      void autosaveActiveAgentDebugBundles(workspaceRef.current, reason)
        .catch(err => {
          // eslint-disable-next-line no-console
          console.warn('[debug-autosave] failed', err)
        })
        .finally(() => {
          if (!disposed) inFlight = false
        })
    }

    // Take an immediate baseline when the mode is enabled so a crash
    // inside the first interval still leaves at least one bundle.
    saveAll('autosave-enabled')
    const timer = window.setInterval(
      () => saveAll('autosave-interval'),
      AUTO_DEBUG_BUNDLE_INTERVAL_MS,
    )
    const onBeforeUnload = () => {
      saveAll('autosave-beforeunload')
    }
    window.addEventListener('beforeunload', onBeforeUnload)

    return () => {
      disposed = true
      window.clearInterval(timer)
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [enabled])
}
