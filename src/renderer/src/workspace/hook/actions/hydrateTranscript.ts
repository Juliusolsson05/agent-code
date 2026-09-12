import type { SessionRuntime } from '@renderer/session-runtime/state'
import { managedTranscriptUnavailableReason } from '@renderer/workspace/agentManagementMcp'
import { loadInitialHistoryForSession } from '@renderer/workspace/hook/actions/initialHistory'
import type { WorkspaceSetRuntimes } from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'

/**
 * Fill an agent's transcript for an Agent Management read without waking it,
 * and report whether that transcript can be trusted.
 *
 * WHY audit reads call the durable-history loader directly instead of
 * ensureSessionLive: restored and buried agents remain valid project records
 * even with no provider process. Transcript inspection must not wake them,
 * mutate their backend lifetime, or consume a provider turn.
 *
 * WHY a `ready` transcript is returned as-is: the live stream already keeps it
 * current, and re-reading would only cost a database/JSONL read per MCP call.
 * Anything else (loading, error, disconnected) re-runs the loader, and the
 * answer is `managedTranscriptUnavailableReason` over what the loader LEFT.
 * That is what makes a fail-closed provider diagnostic stick: when the
 * provider's history source refuses (an OpenCode database with a schema the
 * reader rejects), the loader writes `error` again and this returns
 * `transcript_unavailable`, instead of an empty conversation reported as
 * complete.
 *
 * WHY `read` is injected rather than read from refs: in the app it is the
 * zustand store, which updates synchronously, while the React render that
 * refreshes `latestRuntimesRef` may land after this promise continuation.
 * Reading refs would mistake the stale pre-load runtime for the result.
 * Extracted from the useWorkspace effect so tests drive this exact path.
 */
export async function hydrateTranscriptWithoutWaking({
  sessionId,
  refs,
  setRuntimes,
  read,
}: {
  sessionId: SessionId
  refs: WorkspaceRefs
  setRuntimes: WorkspaceSetRuntimes
  read: () => { state: WorkspaceState; runtimes: Record<SessionId, SessionRuntime> }
}): Promise<'transcript_unavailable' | 'not_created' | null> {
  const before = read()
  const meta = before.state.sessions[sessionId]
  const runtime = before.runtimes[sessionId]
  if (!meta || !runtime || runtime.transcriptStatus === 'ready') {
    return managedTranscriptUnavailableReason(runtime, meta)
  }
  await loadInitialHistoryForSession({ sessionId, refs, setRuntimes, meta })
  const after = read()
  return managedTranscriptUnavailableReason(
    after.runtimes[sessionId],
    after.state.sessions[sessionId],
  )
}
