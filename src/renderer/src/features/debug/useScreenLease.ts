import { useEffect } from 'react'

/**
 * Receive live `session:screen` frames for this session while mounted.
 *
 * WHY a lease (#762): main forwards screen frames only to a renderer that
 * asked for them, because nothing live reads them and they were 93% of IPC
 * bytes (src/main/sessions/screenInterest.ts). Debug surfaces that show the
 * raw screen take a lease for as long as they are open; main seeds the
 * current screen on acquire, so the surface is right even when the backend
 * is idle. Main also drops a renderer's leases on reload, so a missed
 * release can only cost bytes until then, never correctness.
 */
export function useScreenLease(sessionId: string | null | undefined): void {
  useEffect(() => {
    if (!sessionId) return
    void window.api.acquireScreenLease(sessionId)
    return () => {
      void window.api.releaseScreenLease(sessionId)
    }
  }, [sessionId])
}
