import { providerLabel } from '@renderer/workspace/tile-tree/TileLeaf/labels'
import type { SessionKind } from '@renderer/workspace/types'
import type {
  AgentWorkContext,
  WorktreeActivityState,
} from '@renderer/workspace/work-context/types'

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
  const color = colorFor(context.worktreePath)
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
      className="max-w-[180px] truncate px-1.5 py-[1px] text-[10px] font-code leading-none text-white"
      style={{ backgroundColor: color }}
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

function colorFor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0
  }
  const hue = Math.abs(hash) % 360
  return `hsl(${hue} 58% 38%)`
}
