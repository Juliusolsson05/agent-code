import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { DialogActions } from '@renderer/components/ui/dialog-actions'
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
  // Explicit user choices, keyed by session. A row without one takes its
  // default: ticked when selectable, so a completion that lands while the
  // modal is open arrives ticked like every row that was there on open.
  const [choices, setChoices] = useState<Map<SessionId, boolean>>(() => new Map())
  // Rows the user has seen blocked (running, or tied to an open orchestration
  // run). Once blocked, a row defaults to UNticked even after it clears
  // (#1184 review): a row the user watched say "running" must not tick itself
  // and grow the Close count without them doing anything.
  const [seenBlocked, setSeenBlocked] = useState<Set<SessionId>>(() => new Set())
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

  const rows = useMemo(
    () => completedGoalRows(workspace.state, workspace.runtimes, goals),
    [workspace.state, workspace.runtimes, goals],
  )
  useEffect(() => {
    const blocked = rows.filter(row => row.blocked !== null && !seenBlocked.has(row.sessionId))
    if (blocked.length === 0) return
    setSeenBlocked(previous => new Set([...previous, ...blocked.map(row => row.sessionId)]))
  }, [rows, seenBlocked])

  const isChecked = useCallback((row: CompletedGoalRow) =>
    row.blocked === null && (choices.get(row.sessionId) ?? !seenBlocked.has(row.sessionId)),
  [choices, seenBlocked])
  const selected = rows.filter(isChecked)

  const toggle = useCallback((row: CompletedGoalRow) => {
    setChoices(previous => new Map(previous).set(row.sessionId, !isChecked(row)))
  }, [isChecked])

  const closeSelected = useCallback(async () => {
    if (closing || selected.length === 0 || loaded.state !== 'ready') return
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
  }, [closing, loaded.state, onClose, removeLanes, selected, workspace])

  const blockedCount = rows.filter(row => row.blocked !== null).length
  // The close acts only on a fresh read: until then the list is incomplete,
  // and after a failed read it cannot be trusted at all.
  const ready = loaded.state === 'ready'
  const emptyText = loaded.state === 'loading'
    ? 'Loading goals…'
    : loaded.state === 'error'
      ? 'Goals are unavailable.'
      : 'No agent has completed its goal. Agents with Goal MCP mark their goal complete once you have accepted the work, for example after the PR merges.'

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose() }}>
      <DialogContent
        size="lg"
        className="flex max-h-[86vh] flex-col overflow-hidden"
        // IN-FLIGHT EXIT INVARIANT (steering note k3): while the batch close
        // runs, NO path may hide the dialog — not Cancel (disabled below), not
        // Escape, not an outside click. The old footer disabled Cancel while
        // closing; the first DialogActions migration passed only `busy`, which
        // disables the CONFIRM, so Cancel hid a destructive batch that was
        // still killing agents and made the result look cancelled. Same model
        // as Bulk Provider Switch: cancelDisabled + escapeCancels + these two
        // guards.
        onEscapeKeyDown={event => { if (closing) event.preventDefault() }}
        onInteractOutside={event => { if (closing) event.preventDefault() }}
      >
        {/* KEYBOARD (plan S14): the rows stay NATIVE checkboxes — a checkbox
            group is already fully operable (Tab between, Space toggles, state
            announced natively), and every row is an independent destructive
            choice, which is the checkbox pattern rather than the one-cursor
            listbox of K5. What changed is the chrome around them. */}
        <DialogHeader>
          <DialogTitle>Close Completed Agents</DialogTitle>
          <DialogDescription>
            Agents whose goal is complete. Untick any you want to keep.
          </DialogDescription>
        </DialogHeader>

        {loaded.state === 'error' && rows.length > 0 && (
          <div role="alert" className="flex-shrink-0 border-b border-border px-4 py-2 text-[11px] text-danger">
            Goals could not be read, so this list may be out of date. Nothing can be closed from it.
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto" role="list" aria-label="Completed agents">
          {rows.length === 0 ? (
            <div className="px-4 py-10 text-center text-[12px] text-muted">{emptyText}</div>
          ) : rows.map(row => (
            <CompletedRow
              key={row.sessionId}
              row={row}
              checked={isChecked(row)}
              onToggle={toggle}
            />
          ))}
        </div>

        {/* DESTRUCTIVE and bulk (plan K1): no commit key; Cancel keeps ⎋.
            Was a hand-built footer with raw buttons in a third size. */}
        <DialogActions
          tone="danger"
          confirmKey={null}
          busy={closing}
          confirmDisabled={selected.length === 0 || !ready}
          confirmLabel={`Close ${selected.length} Agent${selected.length === 1 ? '' : 's'}`}
          onConfirm={() => void closeSelected()}
          onCancel={onClose}
          cancelDisabled={closing}
          escapeCancels={!closing}
          legend={
            <label className="flex items-center gap-2 text-[11px] text-ink-dim">
              <input
                type="checkbox"
                checked={removeLanes}
                onChange={event => setRemoveLanes(event.target.checked)}
              />
              Also remove their lanes
            </label>
          }
        >
          {blockedCount > 0 ? `${blockedCount} ${blockedCount === 1 ? 'agent stays' : 'agents stay'} open` : null}
        </DialogActions>
      </DialogContent>
    </Dialog>
  )
}

const BLOCKED_LABELS: Record<NonNullable<CompletedGoalRow['blocked']>, string> = {
  running: 'running',
  'workers-open': 'workers still open',
  'coordinator-open': 'coordinator still open',
}

function CompletedRow({ row, checked, onToggle }: { row: CompletedGoalRow; checked: boolean; onToggle: (row: CompletedGoalRow) => void }) {
  const completedAt = Date.parse(row.completedAt)
  return (
    <label
      role="listitem"
      data-session-id={row.sessionId}
      className={`flex items-start gap-3 border-b border-border px-4 py-2.5 last:border-b-0 ${row.blocked ? 'text-ink-dim' : 'cursor-pointer hover:bg-row-hover-bg'}`}
    >
      <input
        type="checkbox"
        checked={checked}
        // A running agent is not finished, whatever its record says, and an
        // agent tied to an open orchestration run cannot close without
        // orphaning the other end. Listed so the user knows why it is not in
        // the count.
        disabled={row.blocked !== null}
        onChange={() => onToggle(row)}
        aria-label={`Close ${row.title}`}
        className="mt-0.5 disabled:opacity-50"
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
        {row.blocked
          ? <span className="text-[11px] text-danger">{BLOCKED_LABELS[row.blocked]}</span>
          : Number.isFinite(completedAt) ? `completed ${relativeTime(completedAt)}` : null}
      </span>
    </label>
  )
}
