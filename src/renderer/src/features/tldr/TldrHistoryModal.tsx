import { useEffect, useState } from 'react'
import type { TldrHistoryEntry } from '@shared/types/tldr'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import type { SessionId } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { tldrTime } from './freshness'
import { tldrIdentityForSession } from './identity'

type Props = {
  open: boolean
  sessionId: SessionId | null
  workspace: Workspace
  onClose: () => void
}

type Loaded =
  | { state: 'loading' }
  | { state: 'ready'; entries: TldrHistoryEntry[] }
  | { state: 'error' }

// TldrHistoryModal — how one agent's reported status evolved, newest first.
//
// WHY the identity rather than the session id: history belongs to the
// conversation, and a reload or provider switch replaces the session id while
// the user is looking at the same agent. `tldrIdentityForSession` is the one
// authority for that mapping, so a duplicate or rewind correctly shows its own
// fresh history instead of its source's.
export function TldrHistoryModal({ open, sessionId, workspace, onClose }: Props) {
  const meta = sessionId ? workspace.state.sessions[sessionId] ?? null : null
  const identity = sessionId && meta ? tldrIdentityForSession(sessionId, meta) : undefined
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  const [now, setNow] = useState(Date.now)

  useEffect(() => {
    if (!open || !identity) return
    let current = true
    const load = () => {
      window.api.readTldrHistory(identity)
        .then(entries => { if (current) setLoaded({ state: 'ready', entries }) })
        .catch(() => { if (current) setLoaded({ state: 'error' }) })
    }
    setLoaded({ state: 'loading' })
    // Subscribe before the first read so an update that lands while the read
    // is in flight still triggers a refresh instead of being lost between them.
    const unsubscribe = window.api.onTldrChanged(update => { if (update.identity === identity) load() })
    load()
    // Relative ages only drift by minutes; a coarse tick keeps them honest
    // without re-rendering the list continuously while it is open.
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => { current = false; unsubscribe(); window.clearInterval(timer) }
  }, [open, identity])

  const body = !identity
    ? <p className="text-sm text-muted">TLDR has never been enabled for this agent.</p>
    : loaded.state === 'loading'
      ? <p className="text-sm text-muted">Loading…</p>
      : loaded.state === 'error'
        ? <p className="text-sm text-muted">TLDR history is unavailable.</p>
        : loaded.entries.length === 0
          ? <p className="text-sm text-muted">No TLDR history yet.</p>
          : <ol className="flex flex-col gap-3" aria-label="TLDR history">
              {loaded.entries.map((entry, index) => {
                const time = tldrTime(Date.parse(entry.writtenAt), now)
                return (
                  <li key={entry.revision} className="flex flex-col gap-1 border-b border-border pb-3 last:border-b-0">
                    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">{entry.text}</p>
                    <span className="text-[11px] text-muted">
                      {index === 0 ? 'Current · ' : ''}
                      <time dateTime={time.iso} title={time.exact}>{time.text}</time>
                    </span>
                  </li>
                )
              })}
            </ol>

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose() }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>TLDR History</DialogTitle>
          <DialogDescription>Each saved TLDR for this agent, newest first. The latest 100 updates are kept.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto pr-1">{body}</div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
