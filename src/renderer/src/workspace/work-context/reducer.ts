import type {
  AgentWorkContext,
  WorktreeIdentity,
} from '@renderer/workspace/work-context/types'
import {
  deriveAgentWorkContext,
  ingestWorktreeRawEvent,
  seedWorktreeActivityFromContext,
} from '@renderer/workspace/work-context/tracker'
export {
  fallbackContext,
  matchWorktree,
} from '@renderer/workspace/work-context/matching'

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
