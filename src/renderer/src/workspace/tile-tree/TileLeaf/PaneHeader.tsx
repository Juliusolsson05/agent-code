import type { ReactNode } from 'react'
import { shortenCwd } from '@renderer/workspace/tile-tree/TileLeaf/labels'
import { useAppStore } from '@renderer/app-state/hooks'
import { useShallow } from 'zustand/react/shallow'
import { PaneHeaderColorFlag } from '@renderer/workspace/tile-tree/TileLeaf/PaneHeaderColorFlag'
import type { GridRelatedAgentTab } from '@renderer/workspace/gridRelatedAgents'
import { dispatchAttentionLabelFromConditions } from '@renderer/workspace/conditions/selectors'
import type { SessionId } from '@renderer/workspace/types'
import type { SessionRuntime } from '@renderer/workspace/workspaceStore'
import { AgentTitleHeader } from '@renderer/workspace/tile-tree/AgentTitleHeader'
import { paneHeaderStatusLit } from '@renderer/workspace/tile-tree/TileLeaf/paneHeaderStatus'

// Pane header: compact status strip.
//
// In status mode, working panes paint with the theme accent;
// idle/exited panes get no fill — the absence of color is the
// signal, so a glance across the grid highlights only the
// panes that still want attention. Previous design used
// green/red, but red read as "error" for merely idle panes.
//
// The right quarter of the strip is owned by the session's color flag when one
// is set (PaneHeaderColorFlag). The two signals are deliberately allowed to
// overlap: liveness is automatic and transient, the flag is manual and sticky,
// so a user who flagged a pane red wants that red regardless of whether the
// agent happens to be running right now. The flag always wins its slice.
//
// That does put color back onto idle panes, which is in tension with the
// paragraph above — a red chunk on an idle pane is exactly the shape of the
// green/red design we abandoned. It is accepted here, and the difference is
// authorship: the old red was assigned automatically and therefore had to be
// read as a status claim ("something is wrong with this pane"), while a flag
// is one the user set by hand for their own reason and is self-explanatory to
// the only person who can see it. If flags ever become automatic — assigned by
// a rule, a provider, or an agent — this reasoning expires and the overlap
// must be revisited.
//
// WHY every agent surface renders THIS header, including the raw terminal view
// (#851): AgentTerminalLeaf used to draw its own copy of this markup. The copy
// was taken before the color flag existed and never received `statusMode`, so
// a turn started from the raw TUI ran under a header that looked idle, and a
// flagged pane lost its flag when switched to Terminal view. The status fill
// and the flag are pane-level signals, meant to be read across the whole grid
// whichever surface a pane shows. So the header has one implementation, and
// surface-specific chrome goes in through `badge` and `trailing` instead of a
// second copy. Don't fork this markup again. Add a slot instead.
export function PaneHeader({
  sessionId,
  paneLabel,
  agentTitle,
  projectDir,
  statusMode,
  isSessionLive,
  relatedAgentTabs = [],
  selectedRelatedSessionId,
  runtimes,
  ownerSessionId,
  onSelectRelatedSession,
  badge,
  trailing,
}: {
  sessionId: SessionId
  paneLabel?: string
  agentTitle?: string
  projectDir: string | null
  statusMode: boolean
  isSessionLive: boolean
  relatedAgentTabs?: GridRelatedAgentTab[]
  selectedRelatedSessionId?: string
  runtimes?: Record<string, SessionRuntime>
  ownerSessionId?: string
  onSelectRelatedSession?: (sessionId: string) => void
  /** Surface identity shown right after the pane label (e.g. `raw claude`). */
  badge?: ReactNode
  /** Surface state pinned to the right end of the status row, left of the
   *  color flag (e.g. the terminal view's TAIL pill). */
  trailing?: ReactNode
}) {
  // Drives the fill and the `data-status-lit` hook together, so tests and
  // debug tooling read exactly what the user sees.
  const statusLit = paneHeaderStatusLit(statusMode, isSessionLive)
  // Related agents can change without rerendering this session. Only the two
  // painted status values are dependencies; subscribing to their entire
  // runtimes would couple every related transcript delta back to this header.
  //
  // WHY the store read is optional-chained instead of a bare index: the phone
  // shares this header, and the phone bundle stubs @renderer/app-state/hooks
  // to a `{ settings }`-only store
  // (src/remote-client/src/stubs/appStateHooks.ts) that has NO
  // `workspaceRuntimes` key. SessionView passes `relatedAgentTabs={[]}`, so
  // today the flatMap body never runs and the key is never touched; the `?.`
  // keeps a hypothetical future phone caller that passes chips from throwing
  // on the missing key, degrading to the `runtimes` prop and then to
  // "unknown" instead. Un-optional-chained, this whole header is sound on the
  // phone only by the empty-array accident of one call site.
  const relatedStatus = useAppStore(useShallow(state => relatedAgentTabs.flatMap(tab => {
    const runtime = state.workspaceRuntimes?.[tab.sessionId] ?? runtimes?.[tab.sessionId]
    return [runtime?.sessionStatus === 'running',
      dispatchAttentionLabelFromConditions(runtime?.conditions ?? null) ?? (runtime?.processError ? 'ERROR' : null)]
  })))
  return (
    <div className="border-b border-border bg-surface text-muted font-code select-none">
      <div
        data-pane-header-row="true"
        data-status-lit={statusLit ? 'true' : 'false'}
        className={`flex items-center justify-between text-[10px] ${
          statusLit ? 'bg-accent text-accent-fg' : 'bg-surface text-muted'
        } ${statusMode ? 'min-h-[5px]' : ''}`}
      >
        {/* WHY ALL of the row's padding moved down onto this group — the row
            used to be `px-3 py-1` and is now bare:

            The color-flag chunk is a sibling flex child that must bleed to all
            three outer edges of the header. `self-stretch` fills the row's
            CONTENT box, so any padding left on the ROW becomes a gap the chunk
            cannot cross — `py-1` would float it 4px off the top and bottom
            (reading as a pill, not a slice of the header) and `pr-3` would hold
            it 12px short of the pane edge. Moving the padding one level down
            satisfies the layout contract in
            docs/plans_and_ideas/2026-07-23-color-flag-layout-follow-up.md
            (flags participate in flex layout; no absolute overlay, no negative
            margin, no painting over padding) while keeping the header's
            rendered height and the label's insets byte-for-byte identical to
            before — the same 12px and 4px still exist, just inside this child.

            The first pass moved only `py` and changed `px-3` to `pl-3`, which
            silently deleted the right inset for UNFLAGGED panes, since the
            chunk that was supposed to stand in for it does not mount when
            there is no flag. Measured on a 100px-wide pane, the truncated
            project dir went from 12px off the pane edge to 0px. Keeping `px-3`
            here instead means the inset survives with or without a flag, and
            the text keeps a real gap from the chunk rather than butting
            against it. Do not move padding back onto the row.

            It also makes the chunk's `w-1/4` a true quarter of the header:
            percentage widths resolve against the row's content box, so with
            `pl-3` still on the row the chunk was 25% of (W − 12px).

            WHY `flex-1` on this group: `trailing` has to sit at the right
            edge, just left of the flag. A content-sized group ends right after
            the cwd, so `ml-auto` would have no free space to push into. For
            callers that pass no `trailing`, nothing moves: the group has no
            background and its content is left-aligned, so filling the row
            only changes where its invisible right padding sits. That padding
            still keeps text 12px from the flag or from the pane edge.

            WHY `@container`: this group's width is exactly the room left for
            text once the flag takes its quarter, whether or not a flag is set.
            Slot content can use container-query variants to drop optional
            labels when that room runs out. A pane-width or viewport query
            would not know about the flag. Containment doesn't change the
            layout here: the group is `flex-1` (basis 0%) with `min-w-0`, so
            its size never depended on its content. Feed.tsx uses the same
            container-query pattern for narrow tiles. */}
        <div className={`@container flex flex-1 items-center gap-2 min-w-0 px-3 ${statusMode ? 'py-0' : 'py-1'}`}>
          {paneLabel && (
            <span className="flex-shrink-0 rounded-chip border border-current/30 px-1 leading-[14px] text-[9px] font-semibold tabular-nums">
              {paneLabel}
            </span>
          )}
          {badge}
          {/* truncate-START: every pane shares the leading path segments, so
              clipping the end hid the one part that identifies this agent. */}
          <span className="truncate-start" title={projectDir ?? 'no project dir'}>
            {/* The inner dir="ltr" is required, not decorative: the outer
                element's rtl direction picks WHICH edge clips, and without
                this the path's own characters are reordered with it. */}
            <span dir="ltr">{shortenCwd(projectDir)}</span>
          </span>
          {/* `flex-shrink-0` on the slot, and `min-width: 0` on
              `.truncate-start`, make the cwd the first thing to give way in a
              narrow pane. Surface state such as TAIL answers "what is this
              pane doing right now", so it should outlast a path that is
              already clipped from the start by design. Nothing here can
              shrink below the chip + badge + slot, though. In a narrow enough
              flagged pane that content still slides under the flag, so slots
              should hide optional labels with `@container` variants (see
              above) instead of assuming unlimited room.

              `pl-1` adds to the group's `gap-2`, so identity (cwd) and state
              (slot) sit at least 12px apart, the separation the terminal
              header had before it shared this row. */}
          {trailing ? (
            <span className="ml-auto flex flex-shrink-0 items-center gap-2 pl-1">
              {trailing}
            </span>
          ) : null}
        </div>
        <PaneHeaderColorFlag sessionId={sessionId} />
      </div>
      {/* WHY this is a distinct row rather than appended beside cwd/index:
          the existing strip is a dense identity + liveness surface whose
          available width is also shared with color flags. The user-authored
          title is the scanning aid; giving it an independent truncation slot
          keeps five narrow Tiled Dispatch lanes legible without weakening the
          existing header contract. Untitled agents render no row at all. */}
      <AgentTitleHeader sessionId={sessionId} title={agentTitle} />
      {relatedAgentTabs.length > 0 && (
        <div className="flex items-center gap-1 overflow-x-auto border-t border-border/70 px-2 py-1 text-[10px]">
          {relatedAgentTabs.map((tab, index) => {
            const active = tab.sessionId === selectedRelatedSessionId
            const running = relatedStatus[index * 2]
            const attention = relatedStatus[index * 2 + 1]
            const title = `${tab.relation}: ${tab.title}${tab.placement === 'detached' ? ' (detached)' : ''}`
            return (
              <button
                key={tab.sessionId}
                type="button"
                title={title}
                aria-pressed={active}
                onMouseDown={event => event.preventDefault()}
                onClick={event => {
                  event.stopPropagation()
                  onSelectRelatedSession?.(tab.sessionId)
                }}
                className={[
                  'flex h-5 max-w-[160px] flex-shrink-0 items-center gap-1 rounded-control border px-1.5',
                  'leading-none transition-colors',
                  active
                    ? 'border-accent bg-accent text-accent-fg'
                    : 'border-border bg-canvas text-muted hover:border-accent/70 hover:text-ink',
                ].join(' ')}
              >
                <span
                  // WHY a data attribute and not a role or aria-label: the dot
                  // is decorative (the chip's `title` already carries the
                  // relation and name for assistive tech), but tests need a
                  // hook that does not depend on Tailwind class names. The
                  // header row already uses `data-pane-header-row` for the
                  // same reason, so this follows that precedent.
                  data-related-status={
                    attention === 'ERROR' ? 'error' : attention ? 'attention' : running ? 'running' : 'idle'
                  }
                  className={[
                    'h-1.5 w-1.5 flex-shrink-0 rounded-full',
                    attention === 'ERROR'
                      ? 'bg-danger'
                      : attention
                        ? 'bg-warning'
                        : running
                          ? 'bg-accent'
                          : 'bg-muted',
                  ].join(' ')}
                />
                <span className="truncate">
                  {tab.sessionId === ownerSessionId ? 'parent' : tab.label}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
