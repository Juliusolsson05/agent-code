import { providerLabel } from '@renderer/workspace/tile-tree/TileLeaf/labels'
import type { SessionKind } from '@renderer/workspace/types'
import type {
  AgentWorkContext,
  WorktreeActivityState,
} from '@shared/work-context/types'
import { worktreeBadgeColor } from '@renderer/workspace/tile-tree/TileLeaf/worktreeBadgeColor'
import { displayedWorktreeContext } from '@renderer/workspace/tile-tree/TileLeaf/displayedWorktree'

export function WorktreeBadge({
  context,
  activity,
  constrainToParent = false,
}: {
  context: AgentWorkContext | null | undefined
  activity: WorktreeActivityState | null | undefined
  constrainToParent?: boolean
}) {
  // The badge is a "where is this agent working now?" signal; see
  // displayedWorktreeContext for which worktree that is.
  const displayContext = displayedWorktreeContext(context, activity)
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
      // `text-white` is deliberate, not a missing token: the badge colour
      // comes from worktreeBadgeColor's FIXED palette of dark shades, never
      // a user colour, and every entry clears WCAG AA against white (lowest
      // is #c026d3 at 4.71:1, checked in the UI pass, G-22). A palette
      // addition must keep that true.
      className={`${widthClasses} truncate rounded-control px-1.5 py-[1px] text-[10px] font-code leading-none text-white`}
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
    <span className="rounded-chip shrink-0 whitespace-nowrap px-1.5 py-[1px] text-[10px] font-code leading-none text-muted border border-border bg-surface-hi">
      {providerLabel(kind)}
    </span>
  )
}

function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}
