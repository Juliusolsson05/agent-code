import { memo, useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { useAppStore } from '@renderer/app-state/hooks'
import type { DispatchAgentRow } from '@renderer/workspace/dispatch/dispatchSelectors'
import { DispatchColorFlagStrip } from '@renderer/workspace/dispatch/DispatchColorFlagStrip'
import type { SessionId } from '@renderer/workspace/types'
import {
  dispatchActivity,
  dispatchActivityClasses,
  dispatchRowTitle,
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
        h-full w-[46px] min-h-0 overflow-y-auto bg-surface [contain:layout_paint]
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
  // WHY this shares the rich index resolver instead of deriving another
  // tooltip label here: the mini selector is the scanning control for Tiled
  // Dispatch. If it keeps the historical latest-prompt-first rule, hover text
  // contradicts the explicit title shown in the adjacent index and pane.
  const title = dispatchRowTitle(row, runtime.entries)

  return (
    <button
      type="button"
      onClick={onClick}
      title={`${row.label} · ${title}`}
      data-dispatch-mini-active={active ? 'true' : undefined}
      // WHY tiled Dispatch carries the same marker as the full index row: a
      // mini-chip click also lands DOM focus on this <button>, so without it
      // the bare-Enter composer router (composerEnterRegistry) would bail on
      // its isInteractiveTarget guard and Enter could not submit an active
      // pane's draft. Tagging it keeps tiled Dispatch behaving identically to
      // the classic list. See issue #236.
      data-dispatch-row="true"
      className={`
        flex w-full items-stretch border-t border-border
        text-[10px] font-semibold tabular-nums
        hover:ring-1 hover:ring-inset hover:ring-accent/40
        ${chipClasses}
      `}
    >
      {/* WHY the label is the flexible remainder instead of another hardcoded
          36px: the selector's left border lives inside its border-box. A 36px
          child plus the 10px flag inside w-[46px] would therefore overflow by
          one pixel. The old w-9 selector already gave its label the 35px inner
          remainder; adding 10px to the outer width and keeping flex-1 preserves
          that exact center while the flag occupies only the newly-added space. */}
      <span className="flex min-w-0 flex-1 items-center justify-center py-1.5">
        {row.label}
      </span>
      <DispatchColorFlagStrip sessionId={row.sessionId} />
    </button>
  )
})
