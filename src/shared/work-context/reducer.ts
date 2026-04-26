import type {
  AgentWorkContext,
  WorktreeIdentity,
} from '@shared/work-context/types'
import {
  deriveAgentWorkContext,
  ingestWorktreeRawEvent,
  seedWorktreeActivityFromContext,
} from '@shared/work-context/tracker'
export {
  fallbackContext,
  matchWorktree,
} from '@shared/work-context/matching'

export function reduceWorkContextFromRaw(
  previous: AgentWorkContext | null,
  raw: unknown,
  worktrees: WorktreeIdentity[],
  sessionCwd: string,
  now = Date.now(),
): AgentWorkContext | null {
  const state = ingestWorktreeRawEvent({
    state: seedWorktreeActivityFromContext(previous, now),
    raw,
    worktrees,
    sessionCwd,
    now,
  })
  return deriveAgentWorkContext(state)
}
