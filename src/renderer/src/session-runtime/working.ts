import type { SessionRuntime } from '@renderer/session-runtime/state'

/**
 * Is this session doing work right now?
 *
 * WHY one function for two call sites (#880): the Dispatch group header's
 * `running/total` count and the worktree panel's `live` flag were the same
 * expression written twice —
 *
 *   `runtime?.sessionStatus === 'running' || runtime?.streamPhase !== 'idle'`
 *
 * — and both were WRONG in the same way. With no runtime, `undefined !==
 * 'idle'` is true, so a session with no runtime entry counted as running
 * while the row beside it rendered `starting` from the same state. Two
 * surfaces disagreeing about one session is how the disagreement gets
 * noticed, and one function is how it stops.
 *
 * A missing runtime is NOT a busy session. It is a session this renderer has
 * no observation of at all — which is exactly what the count should not
 * assert anything about. Orchestration and Agent Management already treat it
 * that way.
 *
 * WHY `streamPhase` counts at all, beside the canonical status: a provider
 * that is mid-turn has a phase before `sessionStatus` settles, and a header
 * that ignored it would read `0 running` while three panes streamed.
 */
export function sessionIsWorking(runtime: SessionRuntime | undefined): boolean {
  if (!runtime) return false
  return runtime.sessionStatus === 'running' || runtime.streamPhase !== 'idle'
}
