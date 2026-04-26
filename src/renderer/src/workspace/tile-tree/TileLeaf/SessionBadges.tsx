import { providerLabel } from '@renderer/workspace/tile-tree/TileLeaf/labels'
import type { SessionKind } from '@renderer/workspace/types'
import type {
  AgentWorkContext,
  WorktreeActivityState,
} from '@renderer/workspace/work-context/types'
import { worktreeBadgeColor } from '@renderer/workspace/work-context/colors'

export function WorktreeBadge({
  context,
  activity,
}: {
  context: AgentWorkContext | null | undefined
  activity: WorktreeActivityState | null | undefined
}) {
  if (!context?.worktreePath) return null
  const label = context.branch ?? shortPath(context.worktreePath)
  if (!label) return null
  const color = worktreeBadgeColor(context)
  const title = [
    'Primary worktree',
    context.branch ? `Branch: ${context.branch}` : null,
    `Worktree: ${context.worktreePath}`,
    `Source: ${context.source}`,
    `Confidence: ${context.confidence}`,
    activity?.active?.worktreePath &&
      activity.active.worktreePath !== context.worktreePath
      ? `Active now: ${activity.active.branch ?? shortPath(activity.active.worktreePath)} (${activity.active.worktreePath})`
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
