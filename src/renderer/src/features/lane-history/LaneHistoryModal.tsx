import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@renderer/app-state/hooks'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { DialogActions } from '@renderer/components/ui/dialog-actions'
import { KbdLegend } from '@renderer/components/ui/kbd'
import { useCommandChordLabel } from '@renderer/features/command-keybindings/useCommandChord'
import { providerGlyph } from '@renderer/features/workspace/lib/sessionDisplay'
import { useListNavigation } from '@renderer/lib/useListNavigation'
import { dispatchRowTitle } from '@renderer/workspace/dispatch/rowTitle'
import { sessionDisplayTitle } from '@renderer/workspace/sessionDisplayTitle'
import type { DispatchLane, SessionId, WorkspaceState } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { DEFAULT_PROVIDER } from '@shared/types/providerKind'
import { leftAgo } from './LaneBackChip'
import { goBackInLane, laneAgentLabel, lanePastEntries, lanePositionLabel, type LanePastEntry } from './laneHistoryModel'

type Props = {
  /** Flat lane index the dialog is for, or null while closed. */
  laneIndex: number | null
  workspace: Workspace
  onClose: () => void
}

// LaneHistoryModal — the FULL list of agents one lane has held.
//
// The everyday paths are ⌥B, the "↶ A2" header chip and the empty lane's
// "Recently here" list; this dialog is where "Lane History…" in the chip's
// menu and the palette command land.
//
// Rebuilt (2026-10-14) to match the app's other agent pickers instead of the
// one-off first version, which the owner found counter-intuitive:
//   - The title says WHICH lane ("Row 1 · Lane 2"). The first version said
//     nothing, so a dialog opened from the wrong lane looked like a bug.
//   - The current agent is a plain "Now:" line, not a clickable row that did
//     nothing when clicked.
//   - Ages say "left 5m ago"; a bare "5m ago" next to "Now" read as when
//     each agent was opened.
//   - Rows follow the house list model: useListNavigation, the listbox holds
//     focus with aria-activedescendant, rows are not tab stops, the accent
//     rail marks the highlight, and the footer has the key legend plus a
//     "Put Back" button that Enter also performs (plan K1–K5, T3, T7, H2–H5).
//     Each row shows the index label, provider glyph, title and project — the
//     same identity the index shows.
export function LaneHistoryModal({ laneIndex, workspace, onClose }: Props) {
  const open = laneIndex !== null
  const state = workspace.state
  const laneNow: DispatchLane | undefined = open ? state.stage.lanes[laneIndex] : undefined
  const entries = open ? lanePastEntries(state, laneIndex) : NO_ENTRIES
  const backChord = useCommandChordLabel('lane-back')

  // The dialog is about ONE lane, but uiShell can only hold its flat index.
  // An index is not an identity: a lane removed or inserted before it (by an
  // agent through the ac_* tools, a close that removes a lane, Stage Shape)
  // slides a DIFFERENT lane into that slot, and the dialog would list that
  // lane's past and put the pick there (#1504 review). Lane objects are
  // replaced only when that lane itself is written — grid edits and remaps
  // keep untouched lanes by reference — so "the object at this slot is not
  // the one we opened on" means the lane changed under us. Closing is the
  // honest answer: the list on screen no longer describes anything.
  const openedLane = useRef<DispatchLane | undefined>(undefined)
  useEffect(() => {
    openedLane.current = open ? workspace.state.stage.lanes[laneIndex] : undefined
    // Capture only on open / retarget, never on later lane writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, laneIndex])
  const laneChanged = open && openedLane.current !== undefined && laneNow !== openedLane.current
  useEffect(() => {
    if (laneChanged) onClose()
  }, [laneChanged, onClose])

  // Relative ages drift by minutes; a coarse tick keeps them honest without
  // re-rendering continuously (same cadence as Report History).
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [open])

  const choose = (index: number) => {
    const entry = entries[index]
    // Same guard at pick time: the close above runs after a render, and a
    // click or Enter can land in between.
    if (laneIndex === null || laneChanged || !entry) return
    onClose()
    goBackInLane(workspace, laneIndex, { target: entry.sessionId, chord: backChord })
  }

  const list = useListNavigation({
    count: entries.length,
    resetKey: open ? laneIndex : null,
    idPrefix: 'lane-history-row',
    keys: entries.map(entry => entry.sessionId),
    onActivate: choose,
  })
  const listRef = useRef<HTMLDivElement>(null)
  const position = open ? lanePositionLabel(state, laneIndex) : null
  const current = laneNow?.selectedSessionId && state.sessions[laneNow.selectedSessionId]
    ? laneNow.selectedSessionId
    : null

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose() }}>
      <DialogContent
        size="default"
        className="flex max-h-[86vh] flex-col"
        onKeyDown={event => { list.onKeyDown(event) }}
        onOpenAutoFocus={event => {
          // Focus the LISTBOX (plan K1): it carries aria-activedescendant,
          // which only announces from the focused element. With no rows keep
          // Radix's default (Close), or focus falls to <body> and Enter does
          // nothing.
          if (entries.length === 0) return
          event.preventDefault()
          listRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>Lane History{position ? ` — ${position}` : ''}</DialogTitle>
          <DialogDescription>Agents that were in this lane, newest first. Pick one to put it back.</DialogDescription>
        </DialogHeader>
        {/* The body pads itself: DialogContent has no padding (#1188). */}
        <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 py-3">
          {entries.length === 0 ? (
            <p className="text-[12px] text-muted">No other agent has been in this lane yet.</p>
          ) : (
            <div
              ref={listRef}
              role="listbox"
              tabIndex={0}
              aria-label="Lane history"
              aria-activedescendant={list.activeId}
              className="rounded-slab min-h-0 flex-1 overflow-auto border border-border bg-canvas py-1 outline-none focus-visible:border-focus-ring focus-visible:ring-1 focus-visible:ring-focus-ring"
            >
              {entries.map((entry, index) => (
                <HistoryRow
                  key={entry.sessionId}
                  entry={entry}
                  state={state}
                  now={now}
                  highlighted={index === list.index}
                  itemProps={list.getItemProps(index)}
                />
              ))}
            </div>
          )}
          {current ? (
            <p className="truncate text-[11px] text-muted">
              Now: <span className="text-ink-dim">{laneAgentLabel(state, current) ?? ''}</span>{' '}
              {titleOf(state, current)}
            </p>
          ) : null}
        </div>
        <DialogActions
          confirmLabel="Put Back"
          confirmDisabled={entries.length === 0}
          onConfirm={() => choose(list.index)}
          onCancel={onClose}
          cancelLabel="Close"
          // The list's own onKeyDown performs Enter (onActivate); wiring it
          // here too would put the agent back twice. The ↩ chip still shows.
          confirmOnEnter={false}
          legend={<KbdLegend items={[{ keys: ['Up', 'Down'], label: 'move' }]} />}
        />
      </DialogContent>
    </Dialog>
  )
}

const NO_ENTRIES: LanePastEntry[] = []

function titleOf(state: WorkspaceState, sessionId: SessionId): string {
  const meta = state.sessions[sessionId]
  return meta ? sessionDisplayTitle(meta) : ''
}

function HistoryRow({
  entry,
  state,
  now,
  highlighted,
  itemProps,
}: {
  entry: LanePastEntry
  state: WorkspaceState
  now: number
  highlighted: boolean
  itemProps: ReturnType<ReturnType<typeof useListNavigation>['getItemProps']>
}) {
  const runtime = useAppStore(useShallow(store => {
    const current = store.workspaceRuntimes[entry.sessionId]
    return { entries: current?.entries, terminalForeground: current?.terminalForeground }
  }))
  const meta = state.sessions[entry.sessionId]
  if (!meta) return null
  // The index's title rule (explicit title, else latest prompt, else folder),
  // so the row reads as the agent you saw in the index and the strip tooltip.
  const title = dispatchRowTitle(
    { agentTitle: meta.title?.trim() || undefined, kind: meta.kind, title: sessionDisplayTitle(meta) },
    runtime.entries,
    runtime.terminalForeground?.cwd,
  )
  const project = state.tabs.find(tab => tab.id === meta.projectId)?.title
  return (
    <div
      {...itemProps}
      role="option"
      aria-selected={highlighted}
      tabIndex={-1}
      className={`flex w-full cursor-default items-center gap-2 border-l-2 px-3 py-1.5 text-left ${
        highlighted ? 'border-l-accent bg-row-selected-bg' : 'border-l-transparent hover:bg-row-hover-bg'
      }`}
    >
      <span className="w-7 flex-shrink-0 text-[10px] font-semibold tabular-nums text-muted">{laneAgentLabel(state, entry.sessionId) ?? ''}</span>
      <span aria-hidden="true" className="w-3 flex-shrink-0 text-center text-[11px] text-accent">{providerGlyph(meta.kind ?? DEFAULT_PROVIDER)}</span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{title}</span>
      {project ? (
        <span className="max-w-[120px] flex-shrink-0 truncate rounded-chip border border-border bg-surface-hi px-1.5 py-px font-code text-[10px] leading-none text-muted" title={project}>
          {project}
        </span>
      ) : null}
      <span className="w-[84px] flex-shrink-0 text-right text-[10px] tabular-nums text-muted">{leftAgo(entry.at, now)}</span>
    </div>
  )
}
