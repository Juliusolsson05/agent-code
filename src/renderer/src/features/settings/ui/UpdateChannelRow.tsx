import { useEffect, useState } from 'react'
import { OptionCards } from '@renderer/components/ui/option-cards'
import { Alert } from '@renderer/components/ui/alert'

import type { UpdateChannel, UpdateChannelSnapshot } from '@shared/updates/updateChannel'

// Settings → Workspace → Update channel (#1168).
//
// WHY this row owns its read/write instead of being a registry `select`: the
// value lives in main's updates.json, because the updater applies it before
// any window exists (the first check runs 3 minutes after launch). Mirroring
// it into the renderer Settings store would be a second source of truth; the
// same reasoning as CliUpdateBehaviorRow, whose card layout this matches.

const OPTIONS: Array<{ value: UpdateChannel; label: string; description: string }> = [
  {
    value: 'stable',
    label: 'Stable',
    description: 'Tested releases. Recommended.',
  },
  {
    value: 'preview',
    label: 'Preview',
    description:
      "Tonight's build of the next version, every day. New fixes first, but it may have bugs. Switching back to Stable waits for the next stable release; it never downgrades.",
  },
]

export function UpdateChannelRow() {
  const [snapshot, setSnapshot] = useState<UpdateChannelSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.getUpdateChannel().then(
      next => { if (!cancelled) setSnapshot(next) },
      cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)) },
    )
    return () => { cancelled = true }
  }, [])

  const choose = (channel: UpdateChannel) => {
    setError(null)
    void window.api.setUpdateChannel(channel).then(setSnapshot, cause => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  if (!snapshot) return error ? <Alert>{error}</Alert> : <div role="status" className="text-[11px] text-muted">Loading…</div>
  return (
    <div className="flex flex-col gap-1.5">
      {/* The shared radio cards (UI pass, G-17): these were aria-pressed,
          square, and had no focus ring. */}
      <OptionCards label="Update Channel" value={snapshot.channel} options={OPTIONS} columns={2} onChange={choose} />
      <div className="text-[10px] text-muted">
        {snapshot.packaged
          ? `This copy is Agent Code ${snapshot.version}. File → Check for Updates… uses this channel.`
          : `This copy (${snapshot.version}) runs from a local build and never updates itself.`}
      </div>
      {error ? <div role="alert" className="text-[10px] text-danger">{error}</div> : null}
    </div>
  )
}
