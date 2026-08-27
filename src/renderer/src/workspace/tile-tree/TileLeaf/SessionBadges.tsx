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
  constrainToParent = false,
}: {
  context: AgentWorkContext | null | undefined
  activity: WorktreeActivityState | null | undefined
  constrainToParent?: boolean
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

  // WHY the narrow-pane behavior is opt-in instead of a permanent min-width change: Dispatch
  // shares this badge with the composer status row, but its subtitle is intentionally the first
  // item to shrink. Only the wrapping composer row needs the badge to remain one flex item while
  // being capped by the pane itself. That makes wrapping happen between badges without changing
  // Dispatch's established metadata-width allocation.
  const widthClasses = constrainToParent
    ? 'max-w-[min(180px,100%)] shrink-0'
    : 'max-w-[180px]'

  return (
    <span
      className={`${widthClasses} truncate rounded-chip px-1.5 py-[1px] text-[10px] font-code leading-none text-white`}
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
    <span className="shrink-0 whitespace-nowrap px-1.5 py-[1px] text-[10px] font-code leading-none text-muted border border-border bg-surface-hi">
      {providerLabel(kind)}
    </span>
  )
}

function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}
