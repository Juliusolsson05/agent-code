import { memo, useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { useAppStore } from '@renderer/app-state/hooks'
import type { DispatchAgentRow } from '@renderer/workspace/dispatch/dispatchSelectors'
import type { SessionId } from '@renderer/workspace/types'
import {
  cachedLatestPromptTitle,
  dispatchActivity,
  dispatchActivityClasses,
} from '@renderer/workspace/dispatch/DispatchAgentList'

// The Tiled Dispatch lane selector, deliberately stripped to NOTHING but the
// index chips ([A1], [A2], ★1 …) — no titles, no activity dots, no badges,
// no section headers, no tab separators. Rationale (user's call): the rich
// context already lives one lane over in the full pinned index; repeating any
// of it here just wastes the narrow column. To identify what a chip refers
// to, glance back at the index (or hover the chip for its tooltip).
//
// Each chip is visually identical to the full list's index cell — same width
// and same activity background — because it's painted with the SAME
// dispatchActivityClasses(...).index palette. The chip for THIS lane's
// current selection is highlighted (accent). Duplicates are fine: the same
// chip can be the accent selection in more than one lane at once.

type Props = {
  rows: DispatchAgentRow[]
  selectedSessionId?: SessionId
  focused: boolean
  onSelect: (row: DispatchAgentRow) => void
}

export const DispatchMiniList = memo(function DispatchMiniList({
  rows,
  selectedSessionId,
  focused,
  onSelect,
}: Props) {
  return (
    <div
      className={`
        h-full w-full min-h-0 overflow-y-auto bg-surface [contain:layout_paint]
        border-l ${focused ? 'border-accent/60' : 'border-border'}
      `}
    >
      {rows.map(row => (
        <DispatchMiniChip
          key={row.key}
          row={row}
          active={row.sessionId === selectedSessionId}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
})

const DispatchMiniChip = memo(function DispatchMiniChip({
  row,
  active,
  onSelect,
}: {
  row: DispatchAgentRow
  active: boolean
  onSelect: (row: DispatchAgentRow) => void
}) {
  // Read just enough runtime to colour the chip by activity. `entries` is only
  // pulled for the hover tooltip (the prompt title) — it is NOT rendered in
  // the strip itself, keeping this a chips-only column.
  const runtime = useAppStore(useShallow(state => {
    const current = state.workspaceRuntimes[row.sessionId]
    return {
      sessionStatus: current?.sessionStatus,
      streamPhase: current?.streamPhase,
      exited: current?.exited,
      entries: current?.entries,
    }
  }))
  const onClick = useCallback(() => onSelect(row), [onSelect, row])

  const activity = dispatchActivity(runtime)
  // Same palette as the main index's chip cell: activity background, or
  // accent when this chip is the lane's current selection.
  const chipClasses = dispatchActivityClasses(activity, active).index
  const isTerminal = row.kind === 'terminal'
  const title = !isTerminal && runtime.entries
    ? cachedLatestPromptTitle(runtime.entries, row.kind) ?? row.title
    : row.title

  return (
    <button
      type="button"
      onClick={onClick}
      title={`${row.label} · ${title}`}
      data-dispatch-mini-active={active ? 'true' : undefined}
      className={`
        flex w-full items-center justify-center border-t border-border
        py-1.5 text-[10px] font-semibold tabular-nums
        hover:ring-1 hover:ring-inset hover:ring-accent/40
        ${chipClasses}
      `}
    >
      {row.label}
    </button>
  )
})
