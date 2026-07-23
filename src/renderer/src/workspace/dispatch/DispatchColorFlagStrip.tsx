import { memo } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { colorFlagById } from '@renderer/app-state/settings/dispatchColorFlags'
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
export const DispatchColorFlagStrip = memo(function DispatchColorFlagStrip({
  sessionId,
}: {
  sessionId: SessionId
}) {
  const colorFlag = useAppStore(state =>
    colorFlagById(state.settings.dispatchColorFlags[sessionId]),
  )

  return (
    <span
      aria-hidden="true"
      data-dispatch-color-flag={colorFlag?.id ?? 'none'}
      className="pointer-events-none w-[10px] flex-none self-stretch"
      style={colorFlag ? { backgroundColor: colorFlag.color } : undefined}
    />
  )
})
