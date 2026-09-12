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

type HistoryRow = TldrHistoryEntry & { kind: 'tldr' | 'goal' }

type Loaded =
  | { state: 'loading' }
  | { state: 'ready'; entries: HistoryRow[]; unavailable: Array<'tldr' | 'goal'> }
  | { state: 'error' }

// Goals (#936) are interleaved with statuses rather than shown in a second
// list: the question this modal answers is "what happened with this agent",
// and a direction change reads correctly only next to the status around it.
//
// WHY a merge and not a sort: each store already returns its history newest
// first in revision order, which is the truth about that store. Revisions are
// per-store, so only wall-clock time can order ACROSS the two lists — but a
// clock stepping backwards must never reorder an agent's own statuses, which a
// global sort by time would do. Merging keeps each list's order intact and
// uses time only to decide which list's head comes next.
export function mergeHistory(tldr: TldrHistoryEntry[], goal: TldrHistoryEntry[]): HistoryRow[] {
  const rows: HistoryRow[] = []
  let t = 0
  let g = 0
  while (t < tldr.length || g < goal.length) {
    const takeGoal = t >= tldr.length
      || (g < goal.length && Date.parse(goal[g]!.writtenAt) > Date.parse(tldr[t]!.writtenAt))
    rows.push(takeGoal ? { ...goal[g++]!, kind: 'goal' } : { ...tldr[t++]!, kind: 'tldr' })
  }
  return rows
}

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
      // Settled, not all-or-nothing: the two histories are separate files, and
      // one unreadable file must not hide the other. A store deliberately
      // rejects an unreadable history instead of returning [], and repairs it
      // only on that store's own next write — for a goal, which changes
      // rarely, that write may never come.
      void Promise.allSettled([window.api.readTldrHistory(identity), window.api.readGoalHistory(identity)])
        .then(([tldr, goal]) => {
          if (!current) return
          if (tldr.status === 'rejected' && goal.status === 'rejected') {
            setLoaded({ state: 'error' })
            return
          }
          setLoaded({
            state: 'ready',
            entries: mergeHistory(tldr.status === 'fulfilled' ? tldr.value : [], goal.status === 'fulfilled' ? goal.value : []),
            unavailable: [
              ...(tldr.status === 'rejected' ? ['tldr' as const] : []),
              ...(goal.status === 'rejected' ? ['goal' as const] : []),
            ],
          })
        })
    }
    setLoaded({ state: 'loading' })
    // Subscribe before the first read so an update that lands while the read
    // is in flight still triggers a refresh instead of being lost between them.
    const refresh = (update: { identity: string }) => { if (update.identity === identity) load() }
    const unsubscribeTldr = window.api.onTldrChanged(refresh)
    const unsubscribeGoal = window.api.onGoalChanged(refresh)
    load()
    // Relative ages only drift by minutes; a coarse tick keeps them honest
    // without re-rendering the list continuously while it is open.
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => { current = false; unsubscribeTldr(); unsubscribeGoal(); window.clearInterval(timer) }
  }, [open, identity])

  const body = !identity
    ? <p className="text-sm text-muted">TLDR and Goal have never been enabled for this agent.</p>
    : loaded.state === 'loading'
      ? <p className="text-sm text-muted">Loading…</p>
      : loaded.state === 'error'
        ? <p className="text-sm text-muted">History is unavailable.</p>
        : loaded.entries.length === 0
          ? (loaded.unavailable.length > 0 ? null : <p className="text-sm text-muted">No TLDR or goal history yet.</p>)
          : <ol className="flex flex-col gap-3" aria-label="TLDR history">
              {loaded.entries.map((entry, index) => {
                const time = tldrTime(Date.parse(entry.writtenAt), now)
                // "Current" is per kind: the newest goal is still the current
                // goal even when several status updates were written after it.
                const current = loaded.entries.findIndex(other => other.kind === entry.kind) === index
                return (
                  <li key={`${entry.kind}:${entry.revision}`} className="flex flex-col gap-1 border-b border-border pb-3 last:border-b-0">
                    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">{entry.text}</p>
                    <span className="text-[11px] text-muted">
                      {entry.kind === 'goal' ? 'Goal · ' : ''}
                      {current ? 'Current · ' : ''}
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
          <DialogDescription>Each saved TLDR and goal for this agent, newest first. The latest 100 of each are kept.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto pr-1">
          {identity && loaded.state === 'ready' && loaded.unavailable.map(kind => (
            <p key={kind} role="status" className="mb-3 text-sm text-muted">{kind === 'goal' ? 'Goal' : 'TLDR'} history is unavailable.</p>
          ))}
          {body}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
