import { memo } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { useAppStore } from '@renderer/app-state/hooks'
import type { SidekickSummary } from '@shared/sidekicks/types'
import { dispatchActivity, dispatchActivityClasses } from '@renderer/workspace/dispatch/DispatchAgentList'

/**
 * The Sidekick's selector strip: the lane chip column (DispatchMiniList),
 * but listing sidekicks.
 *
 * WHY a strip and not the panel header this replaced (#1493 follow-up): the
 * first cut drew the sidekick inside the side-panel chrome — PanelHeader with
 * ghost Switch / Reload / Remove / Hide buttons, then the leaf's OWN
 * PaneHeader under it. Two headers, buttons no lane has, `bg-surface`
 * instead of the canvas: it read as an extension bolted onto the window
 * rather than one more lane. A lane is boundary → 46px chip strip → leaf, and
 * the leaf's PaneHeader is its only header. The sidekick is now exactly that
 * shape, so switching between sidekicks is the same gesture as switching a
 * lane's agent (click a chip), and the rare actions live where a chip's
 * actions live: its right-click menu (see SidekickPanel's onChipMenu).
 *
 * WHY the chips are drawn here instead of reusing DispatchMiniList: that
 * component takes DispatchAgentRows built from the project index
 * (rowScopedRows, orchestration caps, colour flags), none of which a sidekick
 * has — a sidekick is deliberately outside every project (plan I5). What IS
 * shared is the look: the same 46px column, the same `border-t` chips, and
 * the same dispatchActivityClasses palette, so a working sidekick's chip
 * reads exactly like a working lane agent's.
 */
export const SidekickStrip = memo(function SidekickStrip({
  sidekicks,
  selectedId,
  heldSessions,
  focused,
  onSelect,
  onChipMenu,
  onStripMenu,
  onNew,
}: {
  sidekicks: SidekickSummary[]
  selectedId: string | null
  /** sidekickId → the local session holding it in THIS window. A sidekick
   *  not held here has no runtime to colour its chip from. */
  heldSessions: Record<string, string>
  /** The sidekick owns the keyboard: the strip's edge turns accent, the way
   *  a focused lane's strip does. */
  focused: boolean
  onSelect: (sidekickId: string) => void
  onChipMenu: (sidekickId: string) => void
  /** Right-click on the strip outside a chip (chips stop their own event). */
  onStripMenu: () => void
  onNew: () => void
}) {
  return (
    <div
      onContextMenu={event => {
        event.preventDefault()
        onStripMenu()
      }}
      className={`
        flex h-full w-[46px] min-h-0 flex-shrink-0 flex-col overflow-y-auto bg-surface [contain:layout_paint]
        border-l ${focused ? 'border-accent/60' : 'border-border'}
      `}
    >
      {sidekicks.map((summary, index) => (
        <SidekickChip
          key={summary.id}
          summary={summary}
          label={sidekickChipLabel(index)}
          active={summary.id === selectedId}
          sessionId={heldSessions[summary.id] ?? null}
          onSelect={onSelect}
          onMenu={onChipMenu}
        />
      ))}
      {/* The lane strip's "+N more" button style, so the one extra control
          in the column does not introduce a new visual element. */}
      <button
        type="button"
        onClick={onNew}
        title="New Sidekick…"
        aria-label="New Sidekick…"
        className="flex w-full items-center justify-center border-t border-border py-1 text-[10px] font-semibold text-muted outline-none hover:text-ink hover:ring-1 hover:ring-inset hover:ring-accent/40 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ring"
      >
        +
      </button>
    </div>
  )
})

/**
 * `S1`, `S2`, … in index order. The lane chips say `A1`; `S` is the pane
 * label the sidekick leaf has always carried, so the chip and the pane header
 * name the same thing the same way.
 */
export function sidekickChipLabel(index: number): string {
  return `S${index + 1}`
}

const SidekickChip = memo(function SidekickChip({
  summary,
  label,
  active,
  sessionId,
  onSelect,
  onMenu,
}: {
  summary: SidekickSummary
  label: string
  active: boolean
  sessionId: string | null
  onSelect: (sidekickId: string) => void
  onMenu: (sidekickId: string) => void
}) {
  const runtime = useAppStore(useShallow(state => {
    const current = sessionId ? state.workspaceRuntimes[sessionId] : undefined
    return current
      ? { sessionStatus: current.sessionStatus, streamPhase: current.streamPhase, exited: current.exited }
      : null
  }))
  // A sidekick asleep or live in another window has no runtime here.
  // dispatchActivity reads "no status yet" as `starting`, which would paint
  // every sleeping sidekick as booting; idle is the honest colour for "not
  // doing anything in this window".
  const activity = runtime ? dispatchActivity(runtime) : 'idle'
  const where = summary.liveWindowId && !sessionId ? ' · live in another window' : ''
  return (
    <button
      type="button"
      onClick={() => onSelect(summary.id)}
      onContextMenu={event => {
        event.preventDefault()
        // The strip has its own menu; a chip's must not open both.
        event.stopPropagation()
        onMenu(summary.id)
      }}
      title={`${label} · ${summary.title ?? summary.kind}${where}`}
      aria-current={active ? 'true' : undefined}
      // Same marker as the lane chips: a chip click lands DOM focus on this
      // button, and without it the bare-Enter composer router would refuse to
      // submit the sidekick's draft (issue #236, see DispatchMiniChip).
      data-dispatch-row="true"
      className={`
        flex w-full items-stretch border-t border-border
        text-[10px] font-semibold tabular-nums outline-none
        hover:ring-1 hover:ring-inset hover:ring-accent/40
        focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ring
        ${dispatchActivityClasses(activity, active).index}
      `}
    >
      {/* The lane chip's exact box: label in the flexible remainder, then a
          10px slot where DispatchColorFlagStrip sits. Sidekicks have no
          colour flag, but without the slot the label centres 5px right of
          every lane chip's and the two columns stop lining up. */}
      <span className="flex min-w-0 flex-1 items-center justify-center py-1.5">{label}</span>
      <span aria-hidden="true" className="w-[10px] flex-shrink-0" />
    </button>
  )
})
