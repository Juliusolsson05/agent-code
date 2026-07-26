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
// over the right quarter of the accent fill. `flex-none` keeps it at exactly
// 25% instead of letting the truncating label group push it around.
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
      data-pane-color-flag={colorFlag.id}
      className="pointer-events-none w-1/4 flex-none self-stretch"
      style={{ backgroundColor: colorFlag.color }}
    />
  )
})
