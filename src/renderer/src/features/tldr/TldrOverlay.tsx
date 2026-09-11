import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { TldrRecord } from '@shared/types/tldr'
import { useTldrView } from './viewState'

function newest(previous: TldrRecord | null, next: TldrRecord | undefined): TldrRecord | null {
  return next && (!previous || next.revision > previous.revision) ? next : previous
}

export function TldrOverlay({ identity, enabled }: { identity: string; enabled: boolean }) {
  const visible = useTldrView(state => state.held || state.latched)
  const [snapshot, setSnapshot] = useState<{ identity: string; record: TldrRecord | null; error: boolean }>({ identity, record: null, error: false })
  useEffect(() => {
    if (!visible || !enabled) return
    let current = true
    setSnapshot({ identity, record: null, error: false })
    // Subscribe before reading. The revision prevents a slower disk snapshot
    // from overwriting a newer MCP event received during the initial request.
    // Only visible previews subscribe: thousands of detached agents impose no
    // listeners, polling or model calls while the user is doing normal work.
    const unsubscribe = window.api.onTldrChanged(update => {
      if (current && update.identity === identity) setSnapshot(previous => ({
        identity, record: newest(previous.identity === identity ? previous.record : null, update.record), error: false,
      }))
    })
    void window.api.readTldrs([identity]).then(records => {
      if (current) setSnapshot(previous => ({ identity, record: newest(previous.record, records[identity]), error: false }))
    }).catch(() => {
      if (current) setSnapshot(previous => ({ ...previous, error: previous.record === null }))
    })
    return () => { current = false; unsubscribe() }
  }, [identity, enabled, visible])
  if (!visible) return null
  const record = snapshot.identity === identity ? snapshot.record : null
  const text = !enabled ? 'TLDR is off' : snapshot.error ? 'TLDR unavailable' : record?.text ?? 'No TLDR yet'
  return <div
    data-agent-code-interaction-owner="app"
    data-tldr-overlay=""
    role="note"
    aria-label="Agent TLDR"
    className="absolute inset-0 z-50 flex items-center justify-center bg-black/95 p-6 text-center text-white"
    onMouseDown={event => { event.preventDefault(); event.stopPropagation() }}
    onClick={event => event.stopPropagation()}
  >
    <p className="max-h-full max-w-xl overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere] sm:text-base">{text}</p>
  </div>
}

export function TldrPane({ identity, enabled, children }: { identity: string; enabled: boolean; children: ReactNode }) {
  // Overlay instead of conditional replacement: xterm dimensions, live feed
  // subscriptions, scroll position and composer drafts remain mounted below.
  return <div className="relative h-full min-h-0 min-w-0">
    {children}
    <TldrOverlay identity={identity} enabled={enabled} />
  </div>
}
