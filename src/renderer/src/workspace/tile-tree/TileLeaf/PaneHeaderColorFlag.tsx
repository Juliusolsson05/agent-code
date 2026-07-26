import { memo } from 'react'

import { useColorFlag } from '@renderer/app-state/settings/useColorFlag'
import type { SessionId } from '@renderer/workspace/types'

// The session-header half of the color-flag feature: a flagged agent paints a
// chunk of its pane header in the flag color, so it is spottable while scanning
// the grid and not only while scanning the Dispatch list.
//
// WHY 25% of the header width rather than a fixed pixel chunk: panes in a tiled
// grid vary enormously in width, and a fixed chunk reads as a huge slab in a
// narrow lane and a rounding error in a wide one. A proportional chunk keeps
// the same visual weight in every pane, which is the whole point of a signal
// meant to be recognized peripherally.
//
// WHY nothing is rendered when unflagged — and why that DIFFERS from
// DispatchColorFlagStrip, which always mounts a transparent 10px column:
// that column exists to hold Dispatch labels in vertical alignment across rows.
// Nothing sits to the right of this chunk, so there is no alignment invariant
// to protect here, and permanently reserving a quarter of the header would
// squeeze the project-dir text for a signal that is switched off. If a future
// header ever grows content to the RIGHT of this chunk, that reasoning
// inverts — mount it always and make it transparent, like the Dispatch column.
//
// `self-stretch` (not a fixed height) is what makes it overlap the status
// strip: in Status Mode the header row collapses to ~5px, and the chunk paints
// over the right quarter of the accent fill. `flex-none` stops the truncating
// label group from squeezing it — without it the chunk is a shrinkable flex
// item and a long project dir would eat into it. The quarter is a true quarter
// of the header only because PaneHeader keeps its row unpadded; percentage
// widths resolve against the parent's content box, so padding on the row would
// silently shrink this.
//
// WHY the 1px `border-l border-canvas` seam: the flag colors are raw hex while
// the strip behind them is `bg-accent`, a USER-CHOSEN theme token — and every
// shipped accent preset shares a hue family with at least one flag color
// (coral/red, gold/yellow, amber/orange, sky/blue, lavender/purple,
// lime/green). Without a seam, a user whose accent matches their flag gets no
// signal at all on a live pane, which is the exact moment the flag matters
// most. `canvas` is near-black in dark and near-white in light, so the seam
// separates the chunk from both the accent fill and `bg-surface` in either
// theme. It is 1px inside the chunk's own box, so it costs no layout width.
//
// WHY `title` but still `aria-hidden`: the chunk is a redundant view of state
// the user set themselves and can re-read in the picker, so exposing it to a
// screen reader on every pane header would be noise. The tooltip is for a
// different user — someone who can see the color but cannot name it (red and
// green are the same hue to a deuteranope), for whom "Red flag" on hover is
// the only way to tell two flagged panes apart. That is also why this element,
// unlike DispatchColorFlagStrip, does NOT set `pointer-events-none`: a tooltip
// requires hover. Click-to-focus still works — the mousedown bubbles to the
// pane container's onFocusRequest in TileLeaf.
export const PaneHeaderColorFlag = memo(function PaneHeaderColorFlag({
  sessionId,
}: {
  sessionId: SessionId
}) {
  const colorFlag = useColorFlag(sessionId)
  if (!colorFlag) return null

  return (
    <span
      aria-hidden="true"
      title={`${colorFlag.label} flag`}
      data-pane-color-flag={colorFlag.id}
      className="w-1/4 flex-none self-stretch border-l border-canvas"
      style={{ backgroundColor: colorFlag.color }}
    />
  )
})
