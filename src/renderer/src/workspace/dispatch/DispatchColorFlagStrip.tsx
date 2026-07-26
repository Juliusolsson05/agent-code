import { memo } from 'react'

import { useColorFlag } from '@renderer/app-state/settings/useColorFlag'
import type { SessionId } from '@renderer/workspace/types'

// WHY this is a real, always-mounted flex child rather than conditional
// absolute decoration:
//
// Color flags are an index column. Rows must reserve the same trailing 10px
// whether they are flagged or not so titles and compact labels align while the
// user scans vertically. The first implementation painted over right padding,
// which made the rich list look correct in isolation but gave Tiled Dispatch no
// reusable width contract at all. Keeping the settings lookup and the geometry
// in one component makes every Dispatch selector opt into the same invariant.
//
// The settings lookup itself now lives in `useColorFlag` because the pane
// header reads the same state with different geometry; only the geometry below
// is Dispatch-specific.
//
// WHY this one keeps `pointer-events-none` and gets no `title`, while its pane
// header counterpart takes the opposite choice: this strip sits INSIDE the
// Dispatch row's <button>, which already carries a richer tooltip (the agent
// label, title, and detached state — DispatchAgentList.tsx / DispatchMiniList.tsx).
// A `title` here would not add information, it would REPLACE that tooltip for
// the 10px the strip covers, so hovering the right edge of a row would tell you
// less than hovering anywhere else in it. Swallowing pointer events keeps the
// row's own hover and tooltip intact across its full width. The pane header has
// no such competing tooltip on its right edge, which is why the chunk there can
// afford one.
export const DispatchColorFlagStrip = memo(function DispatchColorFlagStrip({
  sessionId,
}: {
  sessionId: SessionId
}) {
  const colorFlag = useColorFlag(sessionId)

  return (
    <span
      aria-hidden="true"
      data-dispatch-color-flag={colorFlag?.id ?? 'none'}
      className="pointer-events-none w-[10px] flex-none self-stretch"
      style={colorFlag ? { backgroundColor: colorFlag.color } : undefined}
    />
  )
})
