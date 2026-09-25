import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { DialogActions } from '@renderer/components/ui/dialog-actions'
import { Kbd, KbdLegend } from '@renderer/components/ui/kbd'
import { relativeTime } from '@renderer/lib/relativeTime'
import { cn } from '@renderer/lib/utils'
import { providerGlyph } from '@renderer/features/workspace/lib/sessionDisplay'
import type { SessionId } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'

import {
  ACTIVITY_SECTIONS,
  buildActivityRows,
  filterActivityRows,
} from '../model/activityRow'
import type { ActivityRow, ActivitySection } from '../model/activityRow'
import { useFleetNotes } from '../model/useFleetNotes'

// ---------------------------------------------------------------------------
// Agent Activity (#1170, Stages 3–5; modal since #1189).
//
// Replaces the old AgentActivityModal (a flat 760px-wide list; the size was
// never its problem, see below). The owner's verdict on that one was
// "ages and just shit across the board", and the decomposition's evidence says
// why: at 33–48 agents it could not say which agent needed the user, its rows
// all read as the folder name, and it listed panes rather than agents.
//
// WHY a centred Dialog, and not full screen: #1170 shipped it full-viewport,
// and the owner reversed that in #1189 — covering the whole window hid the
// very panes it summarises and made a quick check feel like leaving the
// workspace. The fixes to the old modal were the sectioning, the names and
// the keyboard, not the size, so it is back to an ordinary modal, just a
// larger one. It stays a Dialog rather than a MainSurface takeover for the
// original reason: the primitive already owns the interaction-owner marker
// that stops keys reaching agents, the focus trap, Escape and focus restore,
// and the workspace stays laid out underneath, so no terminal is resized.
//
// KEYBOARD (one grammar, shown in the footer):
//   list focused (the default) — ↑/↓ move, Enter focus the agent, Space
//     select, ⌘A select all shown, ⌫ close the selection (or the highlighted
//     row), any letter jumps into the filter with that letter typed, Esc
//     dismisses.
//   filter focused — typing edits (Space is a space: filters are multi-word),
//     ↑/↓ and Enter still work, Esc clears the filter and returns to the list.
// Space and ⌫ belong to the LIST so that typing a filter can never select or
// close anything, which is the whole reason there are two focus states.
// ---------------------------------------------------------------------------

type Props = {
  open: boolean
  workspace: Workspace
  onClose: () => void
}

const SECTION_TITLES: Record<ActivitySection, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  idle: 'Idle',
  exited: 'Exited',
}

/** What a section says when it is empty. Only "Needs you" is ever shown
 *  empty: "nothing needs you" is an answer, while an empty "Exited" is noise. */
const EMPTY_NEEDS_YOU = 'Nothing needs you.'

const NAME_SOURCE_HINT: Record<ActivityRow['nameSource'], string | null> = {
  title: null,
  goal: 'goal',
  folder: 'folder',
}

function isPrintableKey(event: ReactKeyboardEvent): boolean {
  return event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey
}

export function AgentActivityView({ open, workspace, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState<SessionId | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<SessionId>>(() => new Set())
  const [nowTick, setNowTick] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)

  // Relative times ("3m ago") and the working/idle split both go stale while
  // the view sits open; 10s matches the old modal and Close Old Agents.
  useEffect(() => {
    if (!open) return
    const id = window.setInterval(() => setNowTick(tick => tick + 1), 10_000)
    return () => window.clearInterval(id)
  }, [open])

  // Opening always starts clean: a filter or selection left from last time
  // would silently hide rows, or arm ⌫ against agents the user no longer sees.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelected(new Set())
    setHighlighted(null)
    // (Initial focus moved to DialogContent's onOpenAutoFocus — the rAF here
    // raced Radix's own mount focus.)
  }, [open])

  // Which sessions the notes are read for. Closed → none, so a closed view
  // subscribes to nothing (decomposition, correction 10).
  const fleetIds = useMemo(
    () => (open ? Object.keys(workspace.state.sessions) : []),
    [open, workspace.state.sessions],
  )
  const notes = useFleetNotes(open, workspace.state.sessions, fleetIds)

  const allRows = useMemo<ActivityRow[]>(() => {
    // The `!open` early return is load-bearing: the Dialog hides content, not
    // hooks, and the old modal scanned every transcript on every runtime update
    // while invisible (closedModalDerivations.renderer.test.tsx).
    if (!open) return []
    void nowTick
    return buildActivityRows(workspace.state, workspace.runtimes, notes)
  }, [open, nowTick, workspace.state, workspace.runtimes, notes])

  const rows = useMemo(() => filterActivityRows(allRows, query), [allRows, query])

  const sections = useMemo(
    () => ACTIVITY_SECTIONS.map(section => ({
      section,
      rows: rows.filter(row => row.section === section),
    })),
    [rows],
  )

  const counts = useMemo(() => {
    const out: Record<ActivitySection, number> = { 'needs-you': 0, working: 0, idle: 0, exited: 0 }
    for (const row of allRows) out[row.section] += 1
    return out
  }, [allRows])

  // The highlight is a SESSION, not an index. Rows move between sections as
  // agents start and stop; an index would silently slide onto a different
  // agent under the user's cursor, and ⌫ would close the wrong one.
  const highlightedRow = rows.find(row => row.sessionId === highlighted) ?? rows[0] ?? null

  // Pin the fallback to its SESSION as soon as it is shown (review of #1105).
  // Without this the highlight stayed "whatever is first", so an agent moving
  // ahead in the list between opening and Enter silently changed which agent
  // Enter opened — the same slide the session-keyed highlight exists to stop.
  useEffect(() => {
    if (highlightedRow && highlightedRow.sessionId !== highlighted) setHighlighted(highlightedRow.sessionId)
  }, [highlighted, highlightedRow])

  // Drop selections whose agents are GONE (closed elsewhere, or by the last
  // bulk close). Pruned against every row, not the filtered ones, so "select
  // these three, then filter to find two more" keeps the first three: the
  // cleanup job is usually spread across projects. Hidden selected rows are
  // never closed blind — the confirmation lists every name.
  useEffect(() => {
    setSelected(previous => {
      const present = new Set(allRows.map(row => row.sessionId))
      const next = new Set([...previous].filter(id => present.has(id)))
      return next.size === previous.size ? previous : next
    })
  }, [allRows])

  // Keyed on the highlighted SESSION id, not the row object (review of
  // #1105): rows are rebuilt on every runtime update and every 10s tick, and
  // depending on the object yanked a user who had scrolled away back to the
  // highlight on each rebuild.
  const highlightedId = highlightedRow?.sessionId ?? null
  useEffect(() => {
    if (!highlightedId || !listRef.current) return
    const element = listRef.current.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(highlightedId)}"]`)
    element?.scrollIntoView?.({ block: 'nearest' })
  }, [highlightedId])

  const focusAgent = useCallback((row: ActivityRow) => {
    // Shows the agent on its lane, or on the focused lane when it is parked,
    // waking it first — the same action as clicking it in the agent index.
    void workspace.focusAgentBySessionId(row.sessionId)
    onClose()
  }, [onClose, workspace])

  const closeRows = useCallback((targets: ActivityRow[]) => {
    if (targets.length === 0) return
    // Always through the bulk flow, even for one row: it confirms, closes
    // through the approved executor, and refuses an agent that started working
    // after the user approved it.
    void workspace.closeAgentActivitySelection(
      targets.map(row => ({ sessionId: row.sessionId, name: row.name })),
    )
  }, [workspace])

  const toggleSelected = useCallback((sessionId: SessionId) => {
    setSelected(previous => {
      const next = new Set(previous)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }, [])

  const selectSection = useCallback((sectionRows: ActivityRow[]) => {
    setSelected(previous => {
      const allIn = sectionRows.every(row => previous.has(row.sessionId))
      const next = new Set(previous)
      for (const row of sectionRows) {
        if (allIn) next.delete(row.sessionId)
        else next.add(row.sessionId)
      }
      return next
    })
  }, [])

  // Clamped (plan D4: lists clamp). Deltas of ±rows.length are Home/End.
  const move = useCallback((delta: number) => {
    if (rows.length === 0) return
    const index = highlightedRow ? rows.indexOf(highlightedRow) : -1
    const next = rows[Math.min(rows.length - 1, Math.max(0, index + delta))]
    if (next) setHighlighted(next.sessionId)
  }, [highlightedRow, rows])
  // Rows per PageUp/PageDown. A constant, like useListNavigation's default:
  // measuring the viewport would couple the key to layout for no user gain.
  const PAGE = 10

  const onListKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    // A focused button (the footer's "Close N selected") keeps its native
    // Enter/Space activation (review of #1105: Enter on it used to open the
    // highlighted agent instead, and Space toggled a row).
    if (event.target instanceof HTMLButtonElement) return
    const inFilter = event.target === filterRef.current
    // Tab from the filter lands on the list WITH the query kept, so filtered
    // rows can be selected from the keyboard. Esc would clear the query, and
    // there was no other way back (review of #1105).
    if (inFilter && event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault()
      listRef.current?.focus()
      return
    }
    // Movement (plan K5): ↑↓ and ⌃N/⌃P everywhere, PgUp/PgDn everywhere,
    // Home/End only from the list — in the filter they move the caret. This
    // view keeps its own handler instead of useListNavigation because it
    // layers type-to-filter, Tab-from-filter, Space, ⌘A and ⌫ on the same
    // keydown, and its highlight is already a SESSION id (the reason
    // useListNavigation grew `keys`); the movement rules are the same.
    const ctrlOnly = event.ctrlKey && !event.metaKey && !event.altKey
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || (ctrlOnly && (event.key === 'n' || event.key === 'p'))) {
      event.preventDefault()
      move(event.key === 'ArrowDown' || event.key === 'n' ? 1 : -1)
      return
    }
    if (event.key === 'PageDown' || event.key === 'PageUp') {
      event.preventDefault()
      move(event.key === 'PageDown' ? PAGE : -PAGE)
      return
    }
    if (!inFilter && (event.key === 'Home' || event.key === 'End')) {
      event.preventDefault()
      move(event.key === 'End' ? rows.length : -rows.length)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (highlightedRow) focusAgent(highlightedRow)
      return
    }
    // Everything else in the filter is typing. Esc is handled by
    // onEscapeKeyDown below, because Radix listens for it on the document.
    if (inFilter) return
    if (event.key === ' ') {
      event.preventDefault()
      if (highlightedRow) toggleSelected(highlightedRow.sessionId)
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      selectSection(rows)
      return
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault()
      const chosen = allRows.filter(row => selected.has(row.sessionId))
      closeRows(chosen.length > 0 ? chosen : highlightedRow ? [highlightedRow] : [])
      return
    }
    if (isPrintableKey(event)) {
      // Type-to-filter: the letter lands in the field and focus follows it,
      // so the rest of the word (and any spaces) types normally.
      event.preventDefault()
      setQuery(previous => previous + event.key)
      filterRef.current?.focus()
    }
  }, [allRows, closeRows, focusAgent, highlightedRow, move, rows, selectSection, selected, toggleSelected])

  const selectedRows = allRows.filter(row => selected.has(row.sessionId))

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose() }}>
      <DialogContent
        // A FIXED height (not max-h), so the dialog does not jump in size as
        // the filter narrows the list or agents change section while it is
        // open. 960px fits name, goal, project and state on one row — a
        // deliberate width outside the presets (plan T2), kept with this WHY;
        // the vh/vw caps keep it a modal on a small window. Positioning,
        // surface and border are the primitive's own (#1189).
        className="flex h-[min(760px,86vh)] w-[min(960px,94vw)] flex-col overflow-hidden"
        onKeyDown={onListKeyDown}
        onOpenAutoFocus={event => {
          // The listbox is the focus owner of the highlight (focus-owner
          // invariant, useListNavigation).
          event.preventDefault()
          listRef.current?.focus()
        }}
        onEscapeKeyDown={event => {
          // The first Esc leaves the filter, the second dismisses. One Esc
          // throwing the whole view away because the user wanted to clear what
          // they typed would be the surprise. Handled HERE and not in the
          // keydown handler: Radix listens for Escape on the document, so a
          // React stopPropagation arrives too late to stop the close.
          //
          // A RECORDED EXCEPTION to plan decision D3 ("one Escape closes"):
          // here ANY printable key on the list jumps into the filter
          // (type-to-filter), so text can land in it without the user ever
          // choosing the field — Esc-clears-first is the undo for that. Other
          // dialogs' filters are fields the user deliberately focused.
          if (document.activeElement !== filterRef.current) return
          event.preventDefault()
          setQuery('')
          listRef.current?.focus()
        }}
        aria-describedby="agent-activity-summary"
      >
        {/* Standard header rhythm (plan T3/T5): px-4 py-3, 13px title — it
            was pt-4 pb-3 with a 15px title, the one dialog that did. */}
        <header className="flex-shrink-0 border-b border-border px-4 py-3">
          <div className="flex items-baseline justify-between gap-4">
            <DialogTitle>Agent Activity</DialogTitle>
            <DialogDescription id="agent-activity-summary" className="mt-0 text-[11px] text-muted">
              {counts['needs-you']} need you · {counts.working} working · {counts.idle} idle
              {counts.exited > 0 ? ` · ${counts.exited} exited` : ''}
            </DialogDescription>
          </div>
          <input
            ref={filterRef}
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Type to filter by name, goal, project or provider"
            aria-label="Filter agents"
            // While the filter has focus the arrows still move the highlight,
            // so it is a combobox that carries the active descendant.
            role="combobox"
            aria-expanded
            aria-controls="agent-activity-listbox"
            aria-activedescendant={highlightedRow ? activityRowId(highlightedRow.sessionId) : undefined}
            className="mt-3 w-full rounded-control border border-input-border bg-input-bg px-3 py-1.5 text-[12px] text-ink outline-none placeholder:text-input-placeholder focus-visible:border-input-border-focus focus-visible:ring-1 focus-visible:ring-focus-ring"
          />
        </header>

        <div
          ref={listRef}
          id="agent-activity-listbox"
          // A Tab stop (plan K4, was -1) and the focus owner of the highlight.
          tabIndex={0}
          role="listbox"
          aria-label="Agents"
          aria-multiselectable="true"
          aria-activedescendant={highlightedRow ? activityRowId(highlightedRow.sessionId) : undefined}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-2 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ring"
        >
          {sections.map(({ section, rows: sectionRows }) => {
            if (sectionRows.length === 0 && section !== 'needs-you') return null
            return (
              // role="group" (review of #1105): a plain <section> is a region
              // landmark between the listbox and its options, so strict screen
              // readers stopped associating the rows with the list. A labelled
              // group is the ARIA-sanctioned way to section a listbox.
              <section key={section} role="group" aria-label={SECTION_TITLES[section]} className="mb-4">
                <div className="sticky top-0 z-10 flex items-center justify-between bg-surface py-1.5">
                  <h3 className={cn(
                    'text-[11px] font-medium uppercase tracking-wider',
                    section === 'needs-you' && sectionRows.length > 0 ? 'text-warning' : 'text-muted',
                  )}>
                    {SECTION_TITLES[section]} <span className="tabular-nums">{sectionRows.length}</span>
                  </h3>
                  {sectionRows.length > 0 && (section === 'idle' || section === 'exited') && (
                    <button
                      type="button"
                      tabIndex={-1}
                      onMouseDown={event => event.preventDefault()}
                      onClick={() => selectSection(sectionRows)}
                      className="text-[11px] text-ink-dim hover:text-ink"
                    >
                      {sectionRows.every(row => selected.has(row.sessionId)) ? 'Unselect all' : 'Select all'}
                    </button>
                  )}
                </div>
                {sectionRows.length === 0 ? (
                  <div className="py-2 text-[12px] text-muted">{EMPTY_NEEDS_YOU}</div>
                ) : (
                  sectionRows.map(row => (
                    <ActivityRowView
                      key={row.sessionId}
                      row={row}
                      highlighted={row.sessionId === highlightedRow?.sessionId}
                      selected={selected.has(row.sessionId)}
                      onHover={() => setHighlighted(row.sessionId)}
                      onToggle={() => toggleSelected(row.sessionId)}
                      onOpen={() => focusAgent(row)}
                      onClose={() => closeRows([row])}
                    />
                  ))
                )}
              </section>
            )
          })}
          {rows.length === 0 && query && (
            <div className="py-8 text-center text-[12px] text-muted">No agent matches “{query}”.</div>
          )}
        </div>

        {/* The prose line "↑↓ move · Enter open · Space select · ⌘A select
            all · ⌫ close · type to filter (Tab back to the list) · Esc
            dismiss" became chips (plan H3); Escape moved onto a real Close
            button. The destructive "Close N selected" rides as an extra
            action and keeps its ⌫ chip, because ⌫ performs it. */}
        <DialogActions
          onCancel={onClose}
          cancelLabel="Close"
          legend={
            <KbdLegend
              items={[
                { keys: ['Up', 'Down'], label: 'move' },
                { keys: ['Enter'], label: 'open' },
                { keys: ['Space'], label: 'select' },
                { keys: ['Cmd+A'], label: 'all' },
                { keys: ['Backspace'], label: 'close' },
              ]}
            />
          }
          extraActions={selectedRows.length > 0 ? (
            <Button type="button" variant="destructive-outline" size="sm" onClick={() => closeRows(selectedRows)}>
              Close {selectedRows.length} Selected
              <Kbd binding="Backspace" />
            </Button>
          ) : null}
        />
      </DialogContent>
    </Dialog>
  )
}

function ActivityRowView({ row, highlighted, selected, onHover, onToggle, onOpen, onClose }: {
  row: ActivityRow
  highlighted: boolean
  selected: boolean
  onHover: () => void
  onToggle: () => void
  onOpen: () => void
  onClose: () => void
}) {
  const hint = NAME_SOURCE_HINT[row.nameSource]
  return (
    <div
      id={activityRowId(row.sessionId)}
      role="option"
      aria-selected={selected}
      data-session-id={row.sessionId}
      data-section={row.section}
      onMouseEnter={onHover}
      onClick={onOpen}
      className={cn(
        // rounded-control is legitimate here (radius table: `control` covers
        // option rows) because these rows float inside a padded list. The
        // highlight joins the one row-highlight token (plan T7): it was
        // accent/15 with a surface-hi hover, found nowhere else.
        'group flex cursor-pointer items-center gap-3 rounded-control px-3 py-2',
        'border-l-2', highlighted ? 'border-l-accent bg-row-selected-bg' : 'border-l-transparent hover:bg-row-hover-bg',
      )}
    >
      <input
        type="checkbox"
        checked={selected}
        aria-label={`Select ${row.name}`}
        // Out of the tab order and out of click focus: the keys act on the
        // HIGHLIGHTED row from the list container, and a focused checkbox
        // would split "the row the keys act on" from "the row the user sees"
        // (#867 review, the same trap the old modal's close button had).
        tabIndex={-1}
        onMouseDown={event => event.preventDefault()}
        onClick={event => event.stopPropagation()}
        onChange={onToggle}
        className="flex-shrink-0 accent-accent"
      />
      <span className={cn('w-4 flex-shrink-0 text-center', row.section === 'working' ? 'text-success' : 'text-muted')}>
        {providerGlyph(row.kind)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] text-ink">{row.name}</span>
          {hint ? <span className="flex-shrink-0 text-[10px] uppercase tracking-wider text-muted">{hint}</span> : null}
          {row.pinned ? <span className="flex-shrink-0 text-[10px] text-accent" title="Pinned">★</span> : null}
        </div>
        <div className="truncate text-[11px] text-ink-dim">
          {row.detail ?? ' '}
        </div>
      </div>
      <div className="w-[220px] flex-shrink-0 text-right">
        {row.reason ? (
          <div className={cn('truncate text-[12px]', row.section === 'needs-you' ? 'text-warning' : 'text-danger')}>
            {row.reason}
          </div>
        ) : null}
        <div className="truncate text-[11px] text-muted">
          {row.project} · {row.kind} · {row.onLane ? 'on a lane' : 'parked'}
          {row.lastActiveAt != null ? ` · ${relativeTime(row.lastActiveAt)}` : ''}
        </div>
      </div>
      <div className="flex flex-shrink-0 gap-1" onClick={event => event.stopPropagation()}>
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={event => event.preventDefault()}
          onClick={onClose}
          title="Close (⌫)"
          // Named for its AGENT: the footer now has a "Close" that closes the
          // view, and two same-named buttons that do different things is the
          // ambiguity a screen reader user cannot see past.
          aria-label={`Close ${row.name}`}
          className="rounded-control border border-danger-border px-2 py-0.5 text-[11px] text-danger hover:bg-danger-soft"
        >
          Close
        </button>
      </div>
    </div>
  )
}

/** DOM id of a row, for aria-activedescendant. Session ids are safe in ids. */
function activityRowId(sessionId: SessionId): string {
  return `agent-activity-row-${sessionId}`
}
