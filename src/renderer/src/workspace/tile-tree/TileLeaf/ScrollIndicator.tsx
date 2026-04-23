import { providerLabel } from '@renderer/workspace/tile-tree/TileLeaf/labels'
import type { SessionKind } from '@renderer/workspace/types'

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
}: {
  entryCount: number
  scrollFraction: number
  tailMode: boolean
  sessionKind: SessionKind | undefined
}) {
  if (entryCount === 0) return null
  return (
    <div className="flex-shrink-0 flex justify-end px-3 leading-none">
      <div className="flex items-center gap-2">
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
