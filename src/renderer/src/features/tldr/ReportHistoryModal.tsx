import { useEffect, useState } from 'react'
import type { TldrHistoryEntry } from '@shared/types/tldr'
import type { ReportHistoryKind } from '@renderer/app-state/uiShell/types'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { cn } from '@renderer/lib/utils'
import type { SessionId } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { tldrTime } from './freshness'
import { tldrIdentityForSession } from './identity'

type Props = {
  open: boolean
  kind: ReportHistoryKind
  sessionId: SessionId | null
  workspace: Workspace
  onClose: () => void
}

type HistoryRow = TldrHistoryEntry & { kind: 'tldr' | 'goal' }

type Loaded =
  | { state: 'loading' }
  | { state: 'ready'; entries: HistoryRow[]; unavailable: Array<'tldr' | 'goal'> }
  | { state: 'error' }

// The per-kind copy. Kept as data beside the component rather than branched
// through the JSX, so the two dialogs visibly differ ONLY in what they read and
// what they call themselves — the layout below is deliberately shared.
const COPY: Record<ReportHistoryKind, { title: string; description: string; listLabel: string; empty: string; neverEnabled: string }> = {
  tldr: {
    title: 'TLDR History',
    description: 'Each saved TLDR and goal for this agent, newest first. The latest 100 of each are kept.',
    listLabel: 'TLDR history',
    empty: 'No TLDR or goal history yet.',
    neverEnabled: 'TLDR and Goal have never been enabled for this agent.',
  },
  goal: {
    title: 'Goal History',
    description: 'Each goal this agent set, and when it completed one, newest first. The latest 100 are kept.',
    listLabel: 'Goal history',
    empty: 'No goal history yet.',
    // The identity is minted by EITHER reporting domain (hasReportingDomain),
    // so an agent that only ever had TLDR has an identity and simply an empty
    // goal history; this line is for an agent that never had either.
    neverEnabled: 'Goal has never been enabled for this agent.',
  },
}

// Goals (#936) are interleaved with statuses rather than shown in a second
// list: the question the TLDR history answers is "what happened with this
// agent", and a direction change reads correctly only next to the status
// around it. The Goal history (#1190) is the other question — "what has this
// agent been FOR" — which the ~100 status rows between two goal changes bury.
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

// ReportHistoryModal — how one agent's reported status (kind `tldr`) or goal
// (kind `goal`) evolved, newest first.
//
// WHY the identity rather than the session id: history belongs to the
// conversation, and a reload or provider switch replaces the session id while
// the user is looking at the same agent. `tldrIdentityForSession` is the one
// authority for that mapping, so a duplicate or rewind correctly shows its own
// fresh history instead of its source's.
export function ReportHistoryModal({ open, kind, sessionId, workspace, onClose }: Props) {
  const meta = sessionId ? workspace.state.sessions[sessionId] ?? null : null
  const identity = sessionId && meta ? tldrIdentityForSession(sessionId, meta) : undefined
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  const [now, setNow] = useState(Date.now)
  const copy = COPY[kind]

  useEffect(() => {
    if (!open || !identity) return
    let current = true
    // The goal view neither reads nor subscribes to the TLDR store: statuses
    // change every few minutes, and refetching a goal list on each of them
    // would be pure churn for a list they never appear in.
    const withTldr = kind === 'tldr'
    const load = () => {
      // Settled, not all-or-nothing: the two histories are separate files, and
      // one unreadable file must not hide the other. A store deliberately
      // rejects an unreadable history instead of returning [], and repairs it
      // only on that store's own next write — for a goal, which changes
      // rarely, that write may never come.
      void Promise.allSettled([
        withTldr ? window.api.readTldrHistory(identity) : Promise.resolve([]),
        window.api.readGoalHistory(identity),
      ]).then(([tldr, goal]) => {
        if (!current) return
        // In the goal view only the goal read can fail, so it alone decides
        // "unavailable"; the resolved placeholder above never rejects.
        if (goal.status === 'rejected' && (!withTldr || tldr.status === 'rejected')) {
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
    const unsubscribeTldr = withTldr ? window.api.onTldrChanged(refresh) : () => {}
    const unsubscribeGoal = window.api.onGoalChanged(refresh)
    load()
    // Relative ages only drift by minutes; a coarse tick keeps them honest
    // without re-rendering the list continuously while it is open.
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => { current = false; unsubscribeTldr(); unsubscribeGoal(); window.clearInterval(timer) }
  }, [open, identity, kind])

  const body = !identity
    ? <p className="text-[12px] text-muted">{copy.neverEnabled}</p>
    : loaded.state === 'loading'
      ? <p className="text-[12px] text-muted">Loading…</p>
      : loaded.state === 'error'
        ? <p className="text-[12px] text-muted">History is unavailable.</p>
        : loaded.entries.length === 0
          ? (loaded.unavailable.length > 0 ? null : <p className="text-[12px] text-muted">{copy.empty}</p>)
          : <ol className="flex flex-col" aria-label={copy.listLabel}>
              {loaded.entries.map((entry, index) => {
                const time = tldrTime(Date.parse(entry.writtenAt), now)
                // "Current" is per kind: the newest goal is still the current
                // goal even when several status updates were written after it.
                const current = loaded.entries.findIndex(other => other.kind === entry.kind) === index
                // A completion row's text is the completion note (#1182), so
                // it must never read as a new goal. In the combined view every
                // goal row gets a chip, because there it is the minority kind
                // and the eye has to find it; in the goal view every row is a
                // goal, so only completions are marked.
                const label = entry.kind !== 'goal' ? null
                  : entry.completed ? 'Goal completed'
                    : kind === 'tldr' ? 'Goal' : null
                return (
                  <li key={`${entry.kind}:${entry.revision}`} className="flex flex-col gap-1 border-b border-border py-2.5 first:pt-0 last:border-b-0 last:pb-0">
                    {/* Meta ABOVE the text: the row's kind and age decide how
                        to read it, so they come first. It was a footer line
                        before, where a goal row only showed its kind after
                        its whole paragraph had been read as a status (#1188). */}
                    <div data-slot="history-meta" className="flex items-center gap-2 text-[10px] text-muted">
                      {label ? (
                        <span className={cn(
                          'rounded-chip border px-1 py-px uppercase tracking-wider',
                          entry.completed ? 'border-accent/60 text-accent' : 'border-border-hi text-ink-dim',
                        )}>{label}</span>
                      ) : null}
                      {current ? <span className="text-ink-dim">Current</span> : null}
                      <time dateTime={time.iso} title={time.exact}>{time.text}</time>
                    </div>
                    <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink [overflow-wrap:anywhere]">{entry.text}</p>
                  </li>
                )
              })}
            </ol>

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose() }}>
      {/* WHY the body pads itself: DialogContent has no padding — header and
          footer bring their own `px-4 py-3` — so a body without it runs flush
          against the dialog's edges (#1188, which is exactly what shipped).
          The column layout plus `min-h-0 flex-1` makes the list the only
          scrolling region, so the header and Close stay put however long the
          history is, instead of a fixed 60vh box floating between them. */}
      <DialogContent className="flex max-h-[80vh] w-[min(640px,92vw)] flex-col overflow-hidden">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {identity && loaded.state === 'ready' && loaded.unavailable.map(unavailableKind => (
            <p key={unavailableKind} role="status" className="mb-3 text-[12px] text-muted">{unavailableKind === 'goal' ? 'Goal' : 'TLDR'} history is unavailable.</p>
          ))}
          {body}
        </div>
        <DialogFooter className="flex-shrink-0">
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
