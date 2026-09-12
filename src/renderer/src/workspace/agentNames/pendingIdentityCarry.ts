import type { SessionId } from '@renderer/workspace/types'

/**
 * Successor panes that are mid-`replaceSession` and are about to inherit their
 * predecessor's `agentNameId`.
 *
 * WHY this exists — the name leak it closes:
 *
 * `spawn` deliberately does not mint an identity (see its comment: a seed
 * there would land on the successor and win the replacement spread, renaming a
 * pane that only changed backends). So a freshly spawned successor is
 * committed to `state.sessions` with NO `agentNameId`, and `replaceSession`
 * then awaits `killSessionBackendIfOwned` — a full IPC round trip, i.e. a
 * macrotask boundary. React flushes in that gap. The reconciler, mounted in
 * the same component, sees an identity-less agent, claims one, and main
 * ALLOCATES A NAME AND COMMITS IT TO DISK, advancing `nextIndex`. Only
 * afterwards does the replacement commit overwrite `agentNameId` with the
 * carried one.
 *
 * The allocated name is now referenced by nothing, and the registry guarantees
 * names are never recycled. So the 100-entry vocabulary drained at the rate of
 * REPLACEMENTS — every reload, resume, rewind and provider switch — rather
 * than at the rate of new agents. Roughly a hundred reloads and every new
 * agent is "Apollo 2". Multi-pane Undo Close burned up to N-1 per restored tab
 * on top of that, because it spawns in a sequential await loop.
 *
 * WHY a module-scoped set rather than a threaded ref: the writer
 * (`replaceSession`, in useSessionActions) and the reader
 * (`claimMissingIdentities`, called from useAgentNameReconciler) are siblings
 * under one component with no existing channel between them, and widening
 * SessionActions to carry a naming detail would put a workspace concern in an
 * unrelated public shape. Each BrowserWindow is its own JS realm and session
 * ids are window-scoped, so one module-level set is exactly one window's
 * worth of state. `providerSwitchesInFlight` is the same pattern for the same
 * reason.
 *
 * WHY it is not merely `pendingReplacementSuccessorsRef`: that set exists for
 * a different question and is populated ONLY when main reports a Codex
 * same-rollout handoff transaction. It says nothing about Claude, OpenCode,
 * fresh Codex, or different-transcript swaps, which are most replacements.
 */
const pendingIdentityCarry = new Set<SessionId>()

/**
 * Mark a successor as "its identity is arriving in this same tick's commit".
 * The caller MUST pair this with `releaseIdentityCarry` on every exit path,
 * including failures — a stranded id would leave that pane permanently
 * unnamed, which is the opposite failure and just as bad.
 */
export function reserveIdentityCarry(sessionId: SessionId): void {
  pendingIdentityCarry.add(sessionId)
}

export function releaseIdentityCarry(sessionId: SessionId): void {
  pendingIdentityCarry.delete(sessionId)
}

export function identityCarryIsPending(sessionId: SessionId): boolean {
  return pendingIdentityCarry.has(sessionId)
}

/** Test seam. Never call from application code. */
export function resetIdentityCarryForTests(): void {
  pendingIdentityCarry.clear()
}
