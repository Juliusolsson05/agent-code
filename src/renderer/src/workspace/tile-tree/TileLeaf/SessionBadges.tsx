import { providerLabel } from '@renderer/workspace/tile-tree/TileLeaf/labels'
import type { SessionKind } from '@renderer/workspace/types'
import type {
  AgentWorkContext,
  WorktreeActivityState,
} from '@shared/work-context/types'
import { worktreeBadgeColor } from '@renderer/workspace/tile-tree/TileLeaf/worktreeBadgeColor'

export function WorktreeBadge({
  context,
  activity,
}: {
  context: AgentWorkContext | null | undefined
  activity: WorktreeActivityState | null | undefined
}) {
  // The badge is a "where is this agent working now?" signal, so
  // prefer the latest active worktree over the longer-lived primary
  // score winner. The primary context can lag badly in sessions that
  // start on main and later move to a feature worktree: main has more
  // cumulative events, while activity.active already reflects the
  // most recent command cwd.
  const displayContext = activity?.active?.worktreePath
    ? activity.active
    : context
  if (!displayContext?.worktreePath) return null
  const label = displayContext.branch ?? shortPath(displayContext.worktreePath)
  if (!label) return null
  const color = worktreeBadgeColor(displayContext)
  const title = [
    activity?.active?.worktreePath ? 'Active worktree' : 'Primary worktree',
    displayContext.branch ? `Branch: ${displayContext.branch}` : null,
    `Worktree: ${displayContext.worktreePath}`,
    `Source: ${displayContext.source}`,
    `Confidence: ${displayContext.confidence}`,
    context?.worktreePath &&
      context.worktreePath !== displayContext.worktreePath
      ? `Primary: ${context.branch ?? shortPath(context.worktreePath)} (${context.worktreePath})`
      : null,
    activity
      ? `Touched: ${Object.values(activity.touched).length}`
      : null,
  ].filter(Boolean).join('\n')

  return (
    <span
      className="max-w-[180px] truncate rounded-sm px-1.5 py-[1px] text-[10px] font-code leading-none text-white"
      style={{ backgroundColor: color ?? undefined }}
      title={title}
    >
      {label}
    </span>
  )
}

export function AgentTypeBadge({
  kind,
}: {
  kind: SessionKind | undefined
}) {
  return (
    <span className="px-1.5 py-[1px] text-[10px] font-code leading-none text-muted border border-border bg-surface-hi">
      {providerLabel(kind)}
    </span>
  )
}

function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}
