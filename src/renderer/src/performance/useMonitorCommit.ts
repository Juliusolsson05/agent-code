import { useLayoutEffect } from 'react'
import { rendererOperations } from './monitorOperations'

const pendingOutput = new Set<string>()
export function noteMonitorOutput(sessionId: string): void {
  if (pendingOutput.size < 2048) pendingOutput.add(sessionId)
}

/** The measurement ends in React's layout-commit phase. It is elapsed render
 * to commit time, not React CPU time or a claim that pixels reached the screen.
 * Abandoned concurrent renders never run the effect and produce no sample. */
export function useMonitorCommit(sessionId: string, revision: unknown, visible: boolean): void {
  const startedAt = performance.now()
  useLayoutEffect(() => {
    rendererOperations.observe('transcript.commit', performance.now() - startedAt)
    if (pendingOutput.delete(sessionId)) {
      if (visible && document.visibilityState === 'visible') window.api?.completeMonitorResponse?.(sessionId)
      else {
        // A background tab still commits React state, but counting the time
        // until somebody later opens it as "first rendered output" would fold
        // arbitrary user attention into renderer latency. Provider first-output
        // remains available; retire only the inapplicable render measurement.
        window.api?.cancelMonitorResponse?.(sessionId)
      }
    }
  }, [sessionId, revision, visible])
  useLayoutEffect(() => () => { pendingOutput.delete(sessionId) }, [sessionId])
}
