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
    if (visible && document.visibilityState === 'visible' && pendingOutput.delete(sessionId)) window.api?.completeMonitorResponse?.(sessionId)
  }, [sessionId, revision, visible])
  useLayoutEffect(() => () => { pendingOutput.delete(sessionId) }, [sessionId])
}
