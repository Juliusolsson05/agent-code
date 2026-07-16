import { AgentTypeBadge, WorktreeBadge } from '@renderer/workspace/tile-tree/TileLeaf/SessionBadges'
import type { SessionKind } from '@renderer/workspace/types'
import type {
  AgentWorkContext,
  WorktreeActivityState,
} from '@shared/work-context/types'

// Scroll position indicator — sits just above the composer,
// right-aligned. Shows where you are in the *full transcript on
// disk*, not just inside the currently-loaded buffer.
//
// Why two counts:
//   - entryCount = `runtime.entries.length`, i.e. the lazy-load
//     window the feed actually has in memory. This grows when the
//     user scrolls up and the renderer pages older entries in,
//     and it is what the existing scrollFraction math is
//     calibrated against (Feed emits
//     `fraction = 1 - scrollTop/maxScroll` over the loaded
//     buffer).
//   - totalEntries = the count of JSONL records in the durable
//     transcript file, seeded at resume from the loader and
//     incremented on every live `jsonl-entries` append in
//     useIpcSubscriptions. This is what the user actually wants
//     the denominator to be: "how big is this conversation,
//     should I /compact, should I rewind?"
//
// Position math:
//   inBuffer    = max(1, ceil((1 - scrollFraction) * entryCount))
//   offset      = max(0, totalEntries - entryCount)
//   position    = min(offset + inBuffer, denominator)
//   denominator = max(totalEntries, entryCount, 1)
//
// `denominator = max(totalEntries, entryCount)` defends against
// the brief race where Zustand state for `entries` has updated
// but the totalEntries patch from useIpcSubscriptions hasn't
// landed yet (or vice versa). Without the max the indicator
// would read e.g. "201/200" for a tick. With it the visible
// number is always a coherent X/Y where X ≤ Y. Same argument
// for clamping `position` with `Math.min(..., denominator)`.
//
// When totalEntries is 0 (terminal panes, fresh sessions with no
// JSONL yet) we fall back to the same single-number reading the
// component had before #93 — the indicator just shows where you
// are inside the loaded buffer. That keeps the badge useful in
// sessions where the on-disk total is genuinely unknown.
//
// Provider label next to it (Claude Code / Codex / Terminal) is
// purely informational so a user can tell at a glance which
// provider owns the pane without reading the project dir.
// TAIL pill lights when tail-mode is active; suppresses sticky-
// bottom tracking but the indicator itself still works.
export function ScrollIndicator({
  entryCount,
  totalEntries,
  scrollFraction,
  tailMode,
  sessionKind,
  workContext,
  workActivity,
}: {
  entryCount: number
  totalEntries: number
  scrollFraction: number
  tailMode: boolean
  sessionKind: SessionKind | undefined
  workContext: AgentWorkContext | null | undefined
  workActivity: WorktreeActivityState | null | undefined
}) {
  if (entryCount === 0 && totalEntries === 0) return null

  const inBuffer = Math.max(1, Math.ceil((1 - scrollFraction) * entryCount))
  const denominator = Math.max(totalEntries, entryCount, 1)
  const offset = Math.max(0, totalEntries - entryCount)
  const position = Math.min(offset + inBuffer, denominator)

  return (
    <div className="flex min-w-0 shrink-0 px-3 leading-none">
      {/* WHY this row wraps between badges instead of squeezing their text: Tiled Dispatch can
          make an agent pane narrower than the combined worktree/provider/tail/count width. The
          old max-content row then widened the pane and painted past its right edge. A full-width,
          zero-minimum flex row gives the worktree pill a real constraint while keeping every
          compact status token intact and preserving the historical right alignment. */}
      <div className="flex w-full min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
        <WorktreeBadge
          context={workContext}
          activity={workActivity}
          constrainToParent
        />
        <AgentTypeBadge kind={sessionKind} />
        {tailMode && (
          <span className="shrink-0 whitespace-nowrap text-[10px] font-code uppercase tracking-wider text-accent">
            TAIL
          </span>
        )}
        <span className="shrink-0 whitespace-nowrap text-[12px] font-code tabular-nums text-accent">
          {position}/{denominator}
        </span>
      </div>
    </div>
  )
}
