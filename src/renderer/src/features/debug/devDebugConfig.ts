import { useEffect } from 'react'
import { create } from 'zustand'

import { setSemanticRawCaptureEnabled } from '@renderer/session-runtime/semantic/rawCapture'

// Mirror of main's DevDebugConfig (#494 — was two App.tsx useStates).
// Read once at boot; main does not push updates (changing the config
// requires an app restart), so there is no subscription — just the
// one-shot hydrate. Defaults are false so the debug affordances stay
// hidden if the IPC probe fails: fail-closed is the right direction for
// developer-only surfaces.
type DevDebugConfigState = {
  enabled: boolean
  /** Gates the Attach-Recording-Note command (plan §7b). */
  sessionRecordingEnabled: boolean
}

export const useDevDebugConfig = create<DevDebugConfigState>()(() => ({
  enabled: false,
  sessionRecordingEnabled: false,
}))

// Root effect extracted from App.tsx. Call once from the composition root.
export function useDevDebugConfigSync(): void {
  useEffect(() => {
    let cancelled = false
    void window.api.getDevDebugConfig()
      .then(config => {
        if (cancelled) return
        useDevDebugConfig.setState({
          enabled: config.enabled,
          sessionRecordingEnabled: config.sessionRecordingEnabled,
        })
        // Raw semantic-event capture rides the same dev-debug switch: the
        // payloads it retains are only readable through dev-debug surfaces,
        // so capture-without-panel would be pure heap cost (#375 part C —
        // see rawCapture.ts). Process-wide diagnostic state, not React
        // state, hence the module setter instead of the zustand store.
        setSemanticRawCaptureEnabled(config.enabled)
      })
      .catch(() => {
        if (cancelled) return
        useDevDebugConfig.setState({ enabled: false, sessionRecordingEnabled: false })
      })
    return () => {
      cancelled = true
    }
  }, [])
}
