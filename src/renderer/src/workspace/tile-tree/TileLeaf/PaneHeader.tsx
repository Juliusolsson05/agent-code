import { shortenCwd } from '@renderer/workspace/tile-tree/TileLeaf/labels'
import { PaneHeaderColorFlag } from '@renderer/workspace/tile-tree/TileLeaf/PaneHeaderColorFlag'
import type { GridRelatedAgentTab } from '@renderer/workspace/gridRelatedAgents'
import { dispatchAttentionLabelFromConditions } from '@renderer/workspace/conditions/selectors'
import type { SessionId } from '@renderer/workspace/types'
import type { SessionRuntime } from '@renderer/workspace/workspaceStore'

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
export function PaneHeader({
  sessionId,
  paneLabel,
  projectDir,
  statusMode,
  isSessionLive,
  relatedAgentTabs = [],
  selectedRelatedSessionId,
  runtimes,
  ownerSessionId,
  onSelectRelatedSession,
}: {
  sessionId: SessionId
  paneLabel?: string
  projectDir: string | null
  statusMode: boolean
  isSessionLive: boolean
  relatedAgentTabs?: GridRelatedAgentTab[]
  selectedRelatedSessionId?: string
  runtimes?: Record<string, SessionRuntime>
  ownerSessionId?: string
  onSelectRelatedSession?: (sessionId: string) => void
}) {
  return (
    <div className="border-b border-border bg-surface text-muted font-code select-none">
      <div
        data-pane-header-row="true"
        className={`flex items-center justify-between text-[10px] ${
          statusMode
            ? isSessionLive
              ? 'bg-accent text-accent-fg'
              : 'bg-surface text-muted'
            : 'bg-surface text-muted'
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
            `pl-3` still on the row the chunk was 25% of (W − 12px). */}
        <div className={`flex items-center gap-2 min-w-0 px-3 ${statusMode ? 'py-0' : 'py-1'}`}>
          {paneLabel && (
            <span className="flex-shrink-0 rounded-[3px] border border-current/30 px-1 leading-[14px] text-[9px] font-semibold tabular-nums">
              {paneLabel}
            </span>
          )}
          <span className="truncate" title={projectDir ?? 'no project dir'}>
            {shortenCwd(projectDir)}
          </span>
        </div>
        <PaneHeaderColorFlag sessionId={sessionId} />
      </div>
      {relatedAgentTabs.length > 0 && (
        <div className="flex items-center gap-1 overflow-x-auto border-t border-border/70 px-2 py-1 text-[10px]">
          {relatedAgentTabs.map(tab => {
            const active = tab.sessionId === selectedRelatedSessionId
            const runtime = runtimes?.[tab.sessionId]
            const running = runtime?.sessionStatus === 'running'
            const attention = dispatchAttentionLabelFromConditions(runtime?.conditions ?? null)
              ?? (runtime?.processError ? 'ERROR' : null)
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
                  'flex h-5 max-w-[160px] flex-shrink-0 items-center gap-1 rounded-[3px] border px-1.5',
                  'leading-none transition-colors',
                  active
                    ? 'border-accent bg-accent text-accent-fg'
                    : 'border-border bg-canvas text-muted hover:border-accent/70 hover:text-ink',
                ].join(' ')}
              >
                <span
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
