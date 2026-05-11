import { useState } from 'react'

import { useSystemPerfPoller } from '@renderer/features/system-perf/useSystemPerfPoller'

import { SystemPerfBadge } from '@renderer/features/system-perf/ui/SystemPerfBadge'
import { SystemPerfPopover } from '@renderer/features/system-perf/ui/SystemPerfPopover'

// Top-level system-perf surface mounted in App.tsx's header strip.
//
// WHY one wrapper component (not two siblings in App.tsx):
// - Badge + Popover share the SAME poller result. Mounting them
//   as siblings would either require lifting state into App.tsx
//   (cluttering an already-big file) or duplicating the poller
//   (double-polling).
// - The popover's open/close state is purely local UI — there's
//   no command-palette entry yet (YAGNI), so it doesn't belong
//   on uiShell.
// - Hiding the whole subtree behind one `enabled` check means
//   when CC_SHELL_PERF is off, this entire feature compiles down
//   to a no-op render with zero IPC traffic after the first probe.
export function SystemPerfHeader() {
  const { enabled, current, buffer } = useSystemPerfPoller()
  const [open, setOpen] = useState(false)

  // First probe hasn't finished, OR the flag is off, OR the IPC
  // failed. In any of those cases we render nothing — no
  // placeholder, no spinner. The header should look identical to
  // the no-flag state until we have real data to display.
  if (enabled !== true || !current) return null

  return (
    <div className="relative">
      <SystemPerfBadge
        current={current}
        buffer={buffer}
        open={open}
        onClick={() => setOpen(prev => !prev)}
      />
      <SystemPerfPopover open={open} current={current} buffer={buffer} />
    </div>
  )
}
