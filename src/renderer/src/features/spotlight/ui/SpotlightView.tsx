import { useEffect } from 'react'
import { radioGroupKeyDown } from '@renderer/lib/radioGroupKeys'
import { useAppStore } from '@renderer/app-state/hooks'
import { setPocketView } from '@renderer/features/browser-pocket/actions'
import { useSpotlightPocketMode } from '@renderer/features/browser-pocket/state/spotlightPocketMode'
import { renderWorkspaceLeaf } from '@renderer/workspace/tile-tree/TileTree'
import type { AgentViewMode } from '@renderer/app-state/settings/types'
import { dispatchSessionIdsForTab } from '@renderer/workspace/dispatch/dispatchSelectors'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { SessionId } from '@renderer/workspace/types'

type Props = {
  workspace: Workspace
  agentViewMode: AgentViewMode
  // Threaded from settings like every other workspace surface (#856). A
  // spotlighted pane is the same pane, so it must honor the same toggles.
  showStatusMode: boolean
  showWorktreeBadges: boolean
}

export function SpotlightView({ workspace, agentViewMode, showStatusMode, showWorktreeBadges }: Props) {
  const browserPocketEnabled = useAppStore(state => state.settings.browserPocketEnabled)
  const spotlight = workspace.spotlight
  if (!spotlight) return null
  const tab = workspace.state.tabs.find(item => item.id === spotlight.tabId)
  if (!tab) return null

  // The pill list is the index's visible rows, not the raw project members.
  // Pinned rows render in their own index section, but a focus takeover must
  // still let the user read and watch the pinned agent that command targeting
  // selected.
  //
  // (A `resolveTabSessions` branch covered "Dispatch is off" until #992; the
  // index is always the membership model now. usePaneFocusSanity's validator
  // in hook/invalidation/effects.ts must list exactly this set.)
  const sessionIds = dispatchSessionIdsForTab(workspace.state, tab.id)
  if (sessionIds.length === 0) return null

  const focusedSessionId = sessionIds.includes(spotlight.focusedSessionId)
    ? spotlight.focusedSessionId
    : sessionIds[0]

  return (
    <div className="h-full min-h-0 min-w-0 flex flex-col bg-canvas">
      <div className="flex-shrink-0 border-b border-border bg-surface px-2 py-1">
        <div className="flex items-center gap-1 overflow-x-auto">
          <span className="px-2 text-[10px] uppercase tracking-wider text-muted select-none">
            Spotlight
          </span>
          {sessionIds.map(sessionId => {
            const meta = workspace.state.sessions[sessionId]
            const label = meta?.title || shortLabel(meta?.cwd ?? sessionId)
            const active = sessionId === focusedSessionId
            return (
              <button
                key={sessionId}
                type="button"
                // aria-current, not aria-pressed: exactly one pill is the
                // spotlighted agent, so this is "which one is shown", not an
                // on/off toggle per pill. The accent fill was the only signal,
                // which a screen reader never hears (ledger N5).
                aria-current={active ? 'true' : undefined}
                onClick={() => workspace.setSpotlightSession(sessionId)}
                className={`rounded-control px-2 py-1 text-[11px] font-code border whitespace-nowrap outline-none focus-visible:ring-1 focus-visible:ring-focus-ring ${
                  active
                    ? 'bg-accent text-accent-fg border-accent'
                    : 'bg-canvas text-ink-dim border-border hover:border-border-hi hover:text-ink'
                }`}
              >
                {label}
                {meta?.browserPocket && browserPocketEnabled ? <span className="ml-1 opacity-70" title="Has a browser pocket">◧</span> : null}
              </button>
            )
          })}
          {browserPocketEnabled && workspace.state.sessions[focusedSessionId]?.browserPocket ? (
            <SpotlightPocketModes sessionId={focusedSessionId} workspace={workspace} />
          ) : null}
        </div>
      </div>
      <div className="flex-1 min-h-0 min-w-0">
        {renderWorkspaceLeaf(
          focusedSessionId,
          focusedSessionId,
          workspace,
          tab.id,
          agentViewMode,
          showStatusMode,
          showWorktreeBadges,
          undefined,
          undefined,
          // Spotlight shows the agent WITH its browser pocket (#1142): the
          // same PocketedLeaf the lane uses, always split side by side here.
          { surface: 'spotlight', laneIndex: null, focused: true, dimmed: false },
        )}
      </div>
    </div>
  )
}

function shortLabel(value: string): string {
  const parts = value.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? value
}

/**
 * Split | Browser | Agent (spec §4.3). "Agent" is the pocket's own collapsed
 * view, so it persists with the session; "Browser" (agent shrinks to a rail)
 * is a momentary viewing choice and resets when Spotlight closes.
 */
function SpotlightPocketModes({ sessionId, workspace }: { sessionId: SessionId; workspace: Props['workspace'] }) {
  const browserOnly = useSpotlightPocketMode(s => s.browserOnly)
  const setBrowserOnly = useSpotlightPocketMode(s => s.set)
  useEffect(() => () => setBrowserOnly(false), [setBrowserOnly])
  const view = workspace.state.sessions[sessionId]?.browserPocket?.view
  const mode = view === 'collapsed' ? 'agent' : browserOnly ? 'browser' : 'split'
  const choose = (next: 'split' | 'browser' | 'agent') => {
    setBrowserOnly(next === 'browser')
    workspace.updateBrowserPocket(s => setPocketView(s, sessionId, next === 'agent' ? 'collapsed' : 'open'))
  }
  return (
    <div
      className="ml-auto flex flex-shrink-0 items-center rounded-control border border-border text-[10px]"
      role="radiogroup"
      aria-label="Spotlight layout"
      // Arrows move between the three, Space/Enter choose (the shared radio
      // rule, lib/radioGroupKeys). Before this the group announced itself as
      // a radiogroup but was three separate Tab stops with no arrow keys.
      onKeyDown={radioGroupKeyDown}
    >
      {(['split', 'browser', 'agent'] as const).map(option => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={mode === option}
          // Roving: the chosen layout is the group's one Tab stop.
          tabIndex={mode === option ? 0 : -1}
          onClick={() => choose(option)}
          // rounded-control on the option too, so the inset focus ring follows
          // the group's rounded ends instead of drawing square corners over
          // them.
          className={`rounded-control px-2 py-0.5 capitalize outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ring ${mode === option ? 'bg-accent text-accent-fg' : 'text-ink-dim hover:text-ink'}`}
        >
          {option}
        </button>
      ))}
    </div>
  )
}
