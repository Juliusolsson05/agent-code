import { memo, useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { useAppStore } from '@renderer/app-state/hooks'
import type { DispatchAgentRow } from '@renderer/workspace/dispatch/dispatchSelectors'
import type { SessionId } from '@renderer/workspace/types'
import {
  cachedLatestPromptTitle,
  dispatchActivity,
  dispatchActivityDotClass,
} from '@renderer/workspace/dispatch/DispatchAgentList'

// WHY a separate compact list rather than reusing DispatchAgentList:
// In Tiled Dispatch every non-index lane gets its OWN selector to the left
// of its agent view. The full index (section titles, worktree grouping,
// provider chips, two-line rows) is exactly what the issue says these lanes
// must NOT repeat — they "omit repeated section titles / worktree labels /
// provider chips". So this is a deliberately dense, header-less, one-line
// variant whose only job is "switch which agent this lane shows". The full
// context still lives one lane over in the pinned index (lane 0).
//
// Rows come from the SAME buildVisibleDispatchRows source as the index, so
// the "row N" / label semantics never drift between the two surfaces.

type Props = {
  rows: DispatchAgentRow[]
  selectedSessionId?: SessionId
  // Sessions shown in OTHER lanes. These are greyed out and unselectable
  // here — the one-session-per-lane invariant (see DispatchLane) surfaced
  // in the UI so the user sees why a row is unavailable before clicking.
  claimed: Set<SessionId>
  focused: boolean
  // 1-based lane number shown in the header so a multi-lane cockpit is
  // identifiable at a glance (which selector drives which view).
  laneNumber: number
  onSelect: (row: DispatchAgentRow) => void
}

export const DispatchMiniList = memo(function DispatchMiniList({
  rows,
  selectedSessionId,
  claimed,
  focused,
  laneNumber,
  onSelect,
}: Props) {
  return (
    <div
      className={`
        h-full w-full min-h-0 overflow-y-auto bg-surface [contain:layout_paint]
        border-l ${focused ? 'border-accent/60' : 'border-border'}
      `}
    >
      <div className="sticky top-0 z-10 border-b border-border bg-surface px-2 py-1 text-[9px] uppercase text-muted">
        lane {laneNumber}
      </div>
      {rows.map(row => (
        <DispatchMiniRow
          key={row.key}
          row={row}
          active={row.sessionId === selectedSessionId}
          claimed={claimed.has(row.sessionId)}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
})

const DispatchMiniRow = memo(function DispatchMiniRow({
  row,
  active,
  claimed,
  onSelect,
}: {
  row: DispatchAgentRow
  active: boolean
  claimed: boolean
  onSelect: (row: DispatchAgentRow) => void
}) {
  const runtime = useAppStore(useShallow(state => {
    const current = state.workspaceRuntimes[row.sessionId]
    return {
      sessionStatus: current?.sessionStatus,
      streamPhase: current?.streamPhase,
      exited: current?.exited,
      entries: current?.entries,
    }
  }))
  const onClick = useCallback(() => {
    // The reducer also refuses claimed sessions, but bailing here avoids a
    // pointless no-op dispatch and a focus flicker on a row the user can't
    // actually take.
    if (claimed) return
    onSelect(row)
  }, [claimed, onSelect, row])

  const isTerminal = row.kind === 'terminal'
  const activity = dispatchActivity(runtime)
  const dot = dispatchActivityDotClass(activity)
  const title = !isTerminal && runtime.entries
    ? cachedLatestPromptTitle(runtime.entries, row.kind) ?? row.title
    : row.title

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={claimed}
      title={claimed ? 'shown in another lane' : title}
      data-dispatch-mini-active={active ? 'true' : undefined}
      className={`
        flex w-full items-center gap-1.5 px-2 py-1 text-left border-t border-border
        text-[10px] overflow-hidden [contain:layout_paint]
        ${claimed ? 'opacity-40 cursor-not-allowed' : 'hover:bg-surface-hi'}
        ${active ? 'bg-accent/15 text-ink' : 'text-ink-dim'}
      `}
    >
      <span
        className={`flex-shrink-0 w-1.5 h-1.5 rounded-full ${dot}`}
        aria-hidden="true"
      />
      <span className="flex-shrink-0 w-7 font-semibold tabular-nums text-muted">
        {row.label}
      </span>
      <span className="min-w-0 flex-1 truncate">{title}</span>
    </button>
  )
})
