import type { SessionRuntime } from '@renderer/session-runtime/state'

/**
 * The fields this rule reads. A `Pick` rather than the whole runtime so every
 * caller can share it — `agentFollow` works on its own narrowed `FollowRuntime`
 * and would otherwise have to keep its own copy, which is the thing this
 * function exists to stop.
 */
export type WorkingRuntime = Pick<SessionRuntime, 'sessionStatus' | 'streamPhase'>

/**
 * Is this session doing work right now, as the DISPLAY surfaces mean it?
 *
 * WHY one function (#880): the Dispatch group header's `running/total` count
 * and the worktree panel's `live` flag were the same expression written twice
 * —
 *
 *   `runtime?.sessionStatus === 'running' || runtime?.streamPhase !== 'idle'`
 *
 * — and both were WRONG in the same way. With no runtime, `undefined !==
 * 'idle'` is true, so a session with no runtime entry counted as running while
 * the row beside it rendered `starting` from the same state. Two surfaces
 * disagreeing about one session is how the disagreement gets noticed, and one
 * function is how it stops. The composer's Stop button and `agentFollow` had
 * the same two clauses inline, each with a comment pointing at the others.
 *
 * A missing runtime is NOT a busy session. It is a session this renderer has
 * no observation of at all.
 *
 * WHY `streamPhase` counts beside the canonical status: a provider mid-turn
 * has a phase before `sessionStatus` settles, and a header that ignored it
 * would read `0 running` while three panes streamed.
 *
 * ── WHAT THIS IS DELIBERATELY NOT ──
 * `orchestrationMcp.activityState` and `agentManagementMcp.activityState` ask
 * a DIFFERENT question with four clauses — they add `processActive` and
 * `awaitingAssistant` — and they answer a missing runtime with a third state
 * (`created`, `unknown`, `hibernated`) rather than a boolean. They are not
 * copies of this, and folding them in would change what an MCP caller is told.
 *
 * They do diverge from this rule for a PRESENT runtime that is idle on both
 * clauses here while `processActive` is true: Agent Management says running,
 * this says not working (#1085 review, finding 2). That is a real
 * inconsistency and it is not #880's — #880 is about a MISSING runtime.
 * Whoever unifies the two questions owns choosing which answer a display count
 * should give, which is a product call rather than a refactor.
 */
export function sessionIsWorking(runtime: WorkingRuntime | undefined): boolean {
  if (!runtime) return false
  return runtime.sessionStatus === 'running' || runtime.streamPhase !== 'idle'
}
