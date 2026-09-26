import type { AgentWorkContext, WorktreeActivityState } from '@shared/work-context/types'

/**
 * The worktree this agent is working in NOW: the latest active worktree when
 * there is one, else the primary. Exported so Agent Status reports the same
 * worktree the badge shows (K2-13). The badge's details were a hover title
 * only, and two surfaces choosing differently would answer "where is this
 * agent working?" twice.
 */
export function displayedWorktreeContext(
  context: AgentWorkContext | null | undefined,
  activity: WorktreeActivityState | null | undefined,
): AgentWorkContext | null {
  // Prefer the latest active worktree over the longer-lived primary score
  // winner. The primary context can lag badly in sessions that start on main
  // and later move to a feature worktree: main has more cumulative events,
  // while activity.active already reflects the most recent command cwd.
  const displayContext = activity?.active?.worktreePath ? activity.active : context
  return displayContext?.worktreePath ? displayContext : null
}
