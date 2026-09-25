import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { relativeTime } from '@renderer/lib/relativeTime'
import { providerGlyph } from '@renderer/features/workspace/lib/sessionDisplay'
import { tabIndexLabel } from '@renderer/workspace/tile-tree/paneLabelFormat'
import { completedGoalRows, goalIdentitiesBySession } from '@renderer/workspace/completedGoalAgents'
import type { CompletedGoalRow } from '@renderer/workspace/completedGoalAgents'
import type { SessionId } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { TldrRecord } from '@shared/types/tldr'
import { withVisibleControls } from '@shared/text/visibleControls'

// ---------------------------------------------------------------------------
// Close Completed Agents… (#1182).
//
// The list is the confirmation: every row names the agent, its goal and the
// agent's own completion note, so the user decides from what the agent SAID it
// delivered rather than from a title. Deliberately smaller than Close Old
// Agents — there is no threshold or project picker to tune, because the filter
// is the agent's claim, not a heuristic.
// ---------------------------------------------------------------------------

type Props = {
  open: boolean
  workspace: Pick<Workspace, 'state' | 'runtimes' | 'closeCompletedGoalAgents'>
  onClose: () => void
}

type Loaded = { state: 'loading' } | { state: 'ready' } | { state: 'error' }

export function CloseCompletedAgentsModal({ open, workspace, onClose }: Props) {
  const [goals, setGoals] = useState<Record<string, TldrRecord>>({})
  // The flow re-reads records at every kill, after awaits, so it needs the
  // latest map rather than the one captured by the click's closure.
  const goalsRef = useRef(goals)
  goalsRef.current = goals
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  // Rows the user UNticked. Stored as the exception rather than the selection
  // so a row that becomes complete while the modal is open arrives ticked,
  // matching every row that was there on open.
  const [unticked, setUnticked] = useState<Set<SessionId>>(() => new Set())
  const [removeLanes, setRemoveLanes] = useState(true)
  const [closing, setClosing] = useState(false)

  // The identities are the query; recomputing the key from them means a new
  // agent or a reload re-reads, while an unrelated render does not.
  const identities = useMemo(
    () => goalIdentitiesBySession(workspace.state).map(entry => entry.identity),
    [workspace.state],
  )
  const identityKey = identities.join('\n')

  useEffect(() => {
    if (!open) return
    let current = true
    const wanted = new Set(identities)
    // Subscribe before reading, the TldrOverlay rule: a completion that lands
    // while the first read is in flight must not be lost between them. The
    // revision decides which of the two is newer.
    const unsubscribe = window.api.onGoalChanged(update => {
      if (!current || !wanted.has(update.identity)) return
      setGoals(previous => {
        const existing = previous[update.identity]
        return existing && existing.revision >= update.record.revision
          ? previous
          : { ...previous, [update.identity]: update.record }
      })
    })
    setLoaded({ state: 'loading' })
    void window.api.readGoals(identities).then(records => {
      if (!current) return
      setGoals(previous => {
        const next = { ...previous }
        for (const [identity, record] of Object.entries(records)) {
          const existing = next[identity]
          if (!existing || record.revision > existing.revision) next[identity] = record
        }
        return next
      })
      setLoaded({ state: 'ready' })
    }).catch(() => { if (current) setLoaded({ state: 'error' }) })
    return () => { current = false; unsubscribe() }
    // identityKey stands in for `identities`: same content, stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, identityKey])

  // Each opening starts from "everything ticked, lanes removed": a choice made
  // for last week's batch says nothing about today's.
  useEffect(() => {
    if (!open) return
    setUnticked(new Set())
    setRemoveLanes(true)
  }, [open])

  const rows = useMemo(
    () => completedGoalRows(workspace.state, workspace.runtimes, goals),
    [workspace.state, workspace.runtimes, goals],
  )
  const selected = rows.filter(row => !row.live && !unticked.has(row.sessionId))

  const toggle = useCallback((sessionId: SessionId) => {
    setUnticked(previous => {
      const next = new Set(previous)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }, [])

  const closeSelected = useCallback(async () => {
    if (closing || selected.length === 0) return
    setClosing(true)
    try {
      // THE GRANT is the ticked rows the user is looking at. The flow re-judges
      // each one (still completed, still idle, still placed) before and at
      // every kill, reading goalsRef so a new goal set meanwhile is seen.
      await workspace.closeCompletedGoalAgents(selected.map(row => row.sessionId), {
        removeLanes,
        readGoals: () => goalsRef.current,
      })
      onClose()
    } finally {
      setClosing(false)
    }
  }, [closing, onClose, removeLanes, selected, workspace])

  const runningCount = rows.filter(row => row.live).length
  const emptyText = loaded.state === 'loading'
    ? 'Loading goals…'
    : loaded.state === 'error'
      ? 'Goals are unavailable.'
      : 'No agent has completed its goal. Agents with Goal MCP mark their goal complete once you have accepted the work, for example after the PR merges.'

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose() }}>
      <DialogContent className="flex max-h-[86vh] w-[min(760px,94vw)] flex-col overflow-hidden">
        <div className="flex-shrink-0 border-b border-border px-4 py-3">
          <DialogTitle>Close Completed Agents</DialogTitle>
          <DialogDescription>
            Agents whose goal is complete. Untick any you want to keep.
          </DialogDescription>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto" role="list" aria-label="Completed agents">
          {rows.length === 0 ? (
            <div className="px-4 py-10 text-center text-[12px] text-muted">{emptyText}</div>
          ) : rows.map(row => (
            <CompletedRow
              key={row.sessionId}
              row={row}
              checked={!row.live && !unticked.has(row.sessionId)}
              onToggle={toggle}
            />
          ))}
        </div>

        <div className="flex flex-shrink-0 items-center justify-between gap-3 border-t border-border px-4 py-3">
          <label className="flex items-center gap-2 text-[11px] text-ink-dim">
            <input
              type="checkbox"
              checked={removeLanes}
              onChange={event => setRemoveLanes(event.target.checked)}
              className="accent-current"
            />
            Also remove their lanes
          </label>
          <div className="flex items-center gap-2">
            {runningCount > 0 && (
              <span className="text-[10px] text-muted">
                {runningCount} running {runningCount === 1 ? 'agent stays' : 'agents stay'} open
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              disabled={closing}
              className="rounded-control border border-border px-3 py-1.5 text-[11px] text-ink-dim hover:border-border-hi hover:text-ink disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void closeSelected()}
              disabled={closing || selected.length === 0}
              className={`rounded-control border px-3 py-1.5 text-[11px] ${
                selected.length > 0
                  ? 'border-danger-border bg-danger-soft text-danger hover:bg-danger-soft/80'
                  : 'cursor-not-allowed border-border text-muted opacity-60'
              }`}
            >
              {closing ? 'Closing…' : `Close ${selected.length} Agent${selected.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function CompletedRow({ row, checked, onToggle }: { row: CompletedGoalRow; checked: boolean; onToggle: (sessionId: SessionId) => void }) {
  const completedAt = Date.parse(row.completedAt)
  return (
    <label
      role="listitem"
      data-session-id={row.sessionId}
      className={`flex items-start gap-3 border-b border-border px-4 py-2.5 last:border-b-0 ${row.live ? 'text-ink-dim' : 'cursor-pointer hover:bg-surface-hi'}`}
    >
      <input
        type="checkbox"
        checked={checked}
        // A running agent is not finished, whatever its record says; it is
        // listed so the user knows why it is not in the count.
        disabled={row.live}
        onChange={() => onToggle(row.sessionId)}
        aria-label={`Close ${row.title}`}
        className="mt-0.5 accent-current disabled:opacity-50"
      />
      <span className="min-w-0 flex-1">
        {/* Escaped like every other bulk-close row: title, goal and note all
            come from text an agent controls, and they are what the user reads
            to decide what dies (#1049). */}
        <span className="flex items-center gap-2 text-[12px] text-ink">
          <span className="text-muted">{providerGlyph(row.kind)}</span>
          <span className="truncate">{withVisibleControls(row.title)}</span>
        </span>
        <span className="mt-0.5 block text-[11px] text-ink-dim">{withVisibleControls(row.goal)}</span>
        <span className="mt-0.5 block text-[11px] text-accent">✓ {withVisibleControls(row.completionNote)}</span>
        <span className="mt-0.5 block truncate text-[10px] text-muted">
          {tabIndexLabel(row.tabIndex)} · {withVisibleControls(row.tabTitle)} · {withVisibleControls(row.cwd)}
        </span>
      </span>
      <span className="w-[110px] flex-shrink-0 text-right text-[10px] text-muted">
        {row.live
          ? <span className="text-[11px] text-danger">running</span>
          : Number.isFinite(completedAt) ? `completed ${relativeTime(completedAt)}` : null}
      </span>
    </label>
  )
}
