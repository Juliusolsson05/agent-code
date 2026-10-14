import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
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
import { relativeTime } from '@renderer/lib/relativeTime'
import { dispatchRowTitle } from '@renderer/workspace/dispatch/rowTitle'
import { sessionDisplayTitle } from '@renderer/workspace/sessionDisplayTitle'
import type { DispatchLane, SessionId, WorkspaceState } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'

type Props = {
  /** Flat lane index the dialog is for, or null while closed. */
  laneIndex: number | null
  workspace: Workspace
  onClose: () => void
}

export type LaneHistoryRow = {
  sessionId: SessionId
  /** Epoch ms the agent left the lane; null for the current occupant. */
  at: number | null
}

/**
 * The rows the dialog shows: the current occupant first, then every past
 * occupant that still exists, newest first.
 *
 * WHY the current agent is listed at all: the dialog is a lane's timeline,
 * and "now" is its top. Without it, an empty-looking list for a lane that has
 * only ever held one agent reads like a bug.
 *
 * WHY dead agents are filtered HERE as well as at autosave: autosave prunes on
 * its own tick, so between a close and the next save the lane can still name
 * an agent that is gone. A row for it would be a click that cannot go
 * anywhere.
 */
export function laneHistoryRows(state: WorkspaceState, laneIndex: number): LaneHistoryRow[] {
  const lane = state.stage.lanes[laneIndex]
  if (!lane) return []
  const live = (id: SessionId) => state.sessions[id] !== undefined
  const rows: LaneHistoryRow[] = []
  if (lane.selectedSessionId && live(lane.selectedSessionId)) {
    rows.push({ sessionId: lane.selectedSessionId, at: null })
  }
  for (const entry of lane.history ?? []) {
    if (entry.sessionId !== lane.selectedSessionId && live(entry.sessionId)) {
      rows.push({ sessionId: entry.sessionId, at: entry.at })
    }
  }
  return rows
}

// LaneHistoryModal — every agent that has been in one lane, and how long ago.
//
// Deliberately a plain list of buttons: the whole feature is "which agent was
// here, and put it back". Clicking a row (or Enter on it) brings that agent
// back into THIS lane and focuses the lane — the lane is the thing whose past
// you opened, so "go to that agent" means "make this lane show it again", the
// same as clicking it in the lane's own strip.
export function LaneHistoryModal({ laneIndex, workspace, onClose }: Props) {
  const open = laneIndex !== null
  const rows = open ? laneHistoryRows(workspace.state, laneIndex) : []
  const laneNow: DispatchLane | undefined = open ? workspace.state.stage.lanes[laneIndex] : undefined

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
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!open) return
    const timer = window.setInterval(() => setTick(tick => tick + 1), 30_000)
    return () => window.clearInterval(timer)
  }, [open])

  const choose = (sessionId: SessionId) => {
    // Same guard at click time: the close above runs after a render, and a
    // click can land in between.
    if (laneIndex === null || laneChanged) return
    onClose()
    // Through selectTiledLaneSession, never the raw lane writer: a hibernated
    // agent has to wake before it is placed (#690).
    void workspace.selectTiledLaneSession(laneIndex, sessionId)
    workspace.setTiledFocusedLane(laneIndex)
  }

  // ↑/↓ move between rows. The list is short and keyboard-first users open it
  // from the palette, so Tab alone (which also walks into the footer) was not
  // enough to make "open, arrow down twice, Enter" work.
  const onListKeyDown = (event: KeyboardEvent<HTMLOListElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'))
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'ArrowDown' ? index + 1 : index - 1
    if (next < 0 || next >= buttons.length) return
    event.preventDefault()
    buttons[next]!.focus()
  }

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose() }}>
      {/* The body pads itself: DialogContent has no padding (#1188). */}
      <DialogContent
        size="sm"
        className="flex max-h-[70vh] flex-col overflow-hidden"
        onOpenAutoFocus={event => {
          // Land on the most recent PAST agent — the current one is already on
          // screen, so it is the least likely pick. Skip row 0 only when it IS
          // the current agent: after Clear Lane there is no "Now" row, and
          // skipping anyway put Enter on the older agent (#1504 review). With
          // no rows keep Radix's default (Close), or focus would fall to
          // <body> and Enter would do nothing.
          const buttons = (event.currentTarget as HTMLElement | null)
            ?.querySelectorAll<HTMLButtonElement>('[data-lane-history-list] button')
          const target = rows[0]?.at === null ? buttons?.[1] ?? buttons?.[0] : buttons?.[0]
          if (!target) return
          event.preventDefault()
          target.focus()
        }}
      >
        <DialogHeader className="flex-shrink-0">
          <DialogTitle>Lane History</DialogTitle>
          <DialogDescription>Agents that were in this lane, newest first. Pick one to put it back.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {rows.length === 0 ? (
            <p className="text-[12px] text-muted">No agents have been in this lane yet.</p>
          ) : (
            <ol data-lane-history-list aria-label="Lane history" className="flex flex-col gap-0.5" onKeyDown={onListKeyDown}>
              {rows.map(row => (
                <li key={row.sessionId}>
                  <LaneHistoryButton row={row} workspace={workspace} onChoose={choose} />
                </li>
              ))}
            </ol>
          )}
        </div>
        <DialogActions onCancel={onClose} cancelLabel="Close" />
      </DialogContent>
    </Dialog>
  )
}

function LaneHistoryButton({
  row,
  workspace,
  onChoose,
}: {
  row: LaneHistoryRow
  workspace: Workspace
  onChoose: (sessionId: SessionId) => void
}) {
  const meta = workspace.state.sessions[row.sessionId]
  // The same label the Dispatch index and lane strip show (explicit title,
  // else the latest prompt, else the folder), so the row is recognisable as
  // the agent you saw there rather than a bare folder name.
  const runtime = useAppStore(useShallow(state => {
    const current = state.workspaceRuntimes[row.sessionId]
    return { entries: current?.entries, terminalForeground: current?.terminalForeground }
  }))
  if (!meta) return null
  const title = dispatchRowTitle(
    { agentTitle: meta.title?.trim() || undefined, kind: meta.kind, title: sessionDisplayTitle(meta) },
    runtime.entries,
    runtime.terminalForeground?.cwd,
  )
  const current = row.at === null
  return (
    <button
      type="button"
      onClick={() => onChoose(row.sessionId)}
      className="flex w-full items-center gap-3 rounded-chip px-2 py-1.5 text-left hover:bg-row-hover-bg focus-visible:bg-row-hover-bg focus-visible:outline-none"
    >
      <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{title}</span>
      <span className="flex-shrink-0 text-[11px] text-muted">
        {current ? 'Now' : <time dateTime={new Date(row.at!).toISOString()} title={new Date(row.at!).toLocaleString()}>{relativeTime(row.at!)}</time>}
      </span>
    </button>
  )
}
