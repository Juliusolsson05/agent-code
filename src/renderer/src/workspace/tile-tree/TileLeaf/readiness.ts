import type { SessionRuntime } from '@renderer/session-runtime/state'
import { isSessionExited } from '@renderer/workspace/providerSessionIdentity'

export function resolveReadinessText(runtime: SessionRuntime): string | null {
  if (runtime.transcriptStatus === 'loading') return 'loading transcript'
  if (runtime.transcriptStatus === 'error') {
    return `transcript unavailable${runtime.transcriptError ? `: ${runtime.transcriptError}` : ''}`
  }
  if (runtime.transcriptStatus === 'disconnected') {
    return `transcript disconnected${runtime.transcriptError ? `: ${runtime.transcriptError}` : ''}`
  }
  if (runtime.processStatus === 'failed') {
    return runtime.processError ?? 'agent failed to start'
  }
  if (isSessionExited(runtime)) {
    return `agent exited${runtime.exited !== null ? ` (code ${runtime.exited})` : ''}`
  }

  // WHY idle is silent instead of "starting agent":
  //
  // Detached and buried sessions are deliberately rehydrated as metadata-only
  // runtimes. They wake lazily when the user sends a prompt, so `inputReady`
  // being false while `processStatus` is idle is the healthy parked state—not
  // evidence of work in progress. Showing a permanent startup warning made a
  // resource-saving implementation detail look like failed recovery. Reserve
  // the label for a backend that actually exists and is becoming ready.
  if (runtime.processStatus === 'spawning') return 'starting agent'
  if (runtime.processStatus === 'started' && !runtime.inputReady) return 'starting agent'
  return null
}
