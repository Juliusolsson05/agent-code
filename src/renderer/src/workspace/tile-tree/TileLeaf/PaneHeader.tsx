import { shortenCwd } from '@renderer/workspace/tile-tree/TileLeaf/labels'
import type { GridRelatedAgentTab } from '@renderer/workspace/gridRelatedAgents'
import { dispatchAttentionLabelFromConditions } from '@renderer/workspace/conditions/selectors'
import type { SessionRuntime } from '@renderer/workspace/workspaceStore'

// Pane header: compact status strip.
//
// In status mode, working panes paint with the theme accent;
// idle/exited panes get no fill — the absence of color is the
// signal, so a glance across the grid highlights only the
// panes that still want attention. Previous design used
// green/red, but red read as "error" for merely idle panes.
export function PaneHeader({
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
        className={`flex items-center justify-between px-3 text-[10px] ${
          statusMode
            ? isSessionLive
              ? 'bg-accent text-accent-fg'
              : 'bg-surface text-muted'
            : 'bg-surface text-muted'
        } ${statusMode ? 'py-0 min-h-[5px]' : 'py-1'}`}
      >
        <div className="flex items-center gap-2 min-w-0">
          {paneLabel && (
            <span className="flex-shrink-0 rounded-[3px] border border-current/30 px-1 leading-[14px] text-[9px] font-semibold tabular-nums">
              {paneLabel}
            </span>
          )}
          <span className="truncate" title={projectDir ?? 'no project dir'}>
            {shortenCwd(projectDir)}
          </span>
        </div>
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
                    : 'border-border bg-canvas text-muted hover:border-accent/70 hover:text-fg',
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
