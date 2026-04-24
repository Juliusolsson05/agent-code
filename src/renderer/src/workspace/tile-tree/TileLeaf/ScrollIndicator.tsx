import { providerLabel } from '@renderer/workspace/tile-tree/TileLeaf/labels'
import type { SessionKind } from '@renderer/workspace/types'
import type { AgentWorkContext } from '@renderer/workspace/work-context/types'

// Scroll position indicator — sits just above the composer,
// right-aligned. Shows which entry you're looking at out of the
// total. Feed emits `fraction = 1 - scrollTop/maxScroll`, so
// fraction=0 at the bottom (newest entry visible) and fraction=1
// at the top (oldest). We invert before display so the badge reads
// natural-order: latest = N/N, oldest = 1/N. Floor at 1 so the
// badge never reads 0/N — even at the extreme bottom there's still
// an entry on screen.
//
// Provider label next to it (Claude Code / Codex / Terminal) is
// purely informational so a user can tell at a glance which
// provider owns the pane without reading the project dir.
// TAIL pill lights when tail-mode is active; suppresses sticky-
// bottom tracking but the indicator itself still works.
export function ScrollIndicator({
  entryCount,
  scrollFraction,
  tailMode,
  sessionKind,
  workContext,
}: {
  entryCount: number
  scrollFraction: number
  tailMode: boolean
  sessionKind: SessionKind | undefined
  workContext: AgentWorkContext | null | undefined
}) {
  if (entryCount === 0) return null
  return (
    <div className="flex-shrink-0 flex justify-end px-3 leading-none">
      <div className="flex items-center gap-2">
        <WorktreeBadge context={workContext} />
        <span className="text-[11px] font-code text-muted">
          {providerLabel(sessionKind)}
        </span>
        {tailMode && (
          <span className="text-[10px] font-code uppercase tracking-wider text-accent">
            TAIL
          </span>
        )}
        <span className="text-[12px] font-code tabular-nums text-accent">
          {Math.max(1, Math.ceil((1 - scrollFraction) * entryCount))}/{entryCount}
        </span>
      </div>
    </div>
  )
}

function WorktreeBadge({
  context,
}: {
  context: AgentWorkContext | null | undefined
}) {
  if (!context?.worktreePath) return null
  const label = context.branch ?? shortPath(context.worktreePath)
  if (!label) return null
  const color = colorFor(context.worktreePath)
  const title = [
    context.branch ? `Branch: ${context.branch}` : null,
    `Worktree: ${context.worktreePath}`,
    `Source: ${context.source}`,
    `Confidence: ${context.confidence}`,
  ].filter(Boolean).join('\n')

  return (
    <span
      className="max-w-[180px] truncate rounded-sm px-1.5 py-[1px] text-[10px] font-code leading-none text-white"
      style={{ backgroundColor: color }}
      title={title}
    >
      {label}
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
