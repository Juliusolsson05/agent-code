import { useEffect, useState } from 'react'

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

  if (!snapshot) return <div className="text-[11px] italic text-muted">{error ?? 'Loading…'}</div>
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
        {OPTIONS.map(option => {
          const active = snapshot.channel === option.value
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => { if (!active) choose(option.value) }}
              className={
                'border px-3 py-2 text-left ' +
                (active
                  ? 'border-control-active-bg bg-control-active-bg text-control-active-fg'
                  : 'border-control-border bg-control-bg text-control-fg hover:border-control-border-hover hover:bg-control-hover-bg hover:text-ink')
              }
            >
              <div className="text-[11px]">{option.label}</div>
              <div className={`mt-1 text-[10px] ${active ? 'text-control-active-fg/80' : 'text-muted'}`}>
                {option.description}
              </div>
            </button>
          )
        })}
      </div>
      <div className="text-[10px] text-muted">
        {snapshot.packaged
          ? `This copy is Agent Code ${snapshot.version}. File → Check for Updates… uses this channel.`
          : `This copy (${snapshot.version}) runs from a local build and never updates itself.`}
      </div>
      {error ? <div role="alert" className="text-[10px] text-danger">{error}</div> : null}
    </div>
  )
}
