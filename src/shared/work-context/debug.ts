import type { WorktreeActivityState } from '@shared/work-context/types'

export function summarizeWorktreeActivity(
  state: WorktreeActivityState | null,
): Record<string, unknown> | null {
  if (!state) return null
  return {
    active: state.active,
    primary: state.primary,
    touched: Object.values(state.touched)
      .sort((a, b) => b.score - a.score || b.lastAt - a.lastAt)
      .slice(0, 8),
    recentEvents: state.timeline.slice(-12),
  }
}
