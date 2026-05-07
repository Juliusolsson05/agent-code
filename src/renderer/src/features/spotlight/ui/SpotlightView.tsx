import { renderWorkspaceLeaf } from '@renderer/workspace/tile-tree/TileTree'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import { dispatchSessionIdsForTab } from '@renderer/workspace/dispatch/dispatchSelectors'
import type { Workspace } from '@renderer/workspace/workspaceStore'

type Props = {
  workspace: Workspace
}

export function SpotlightView({ workspace }: Props) {
  const spotlight = workspace.spotlight
  if (!spotlight) return null
  const tab = workspace.state.tabs.find(item => item.id === spotlight.tabId)
  if (!tab) return null

  const sessionIds = workspace.dispatchMode
    ? dispatchSessionIdsForTab(workspace.state, tab.id)
    : collectLeaves(tab.root)
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
                onClick={() => workspace.setSpotlightSession(sessionId)}
                className={`px-2 py-1 text-[11px] font-code border whitespace-nowrap ${
                  active
                    ? 'bg-accent text-accent-fg border-accent'
                    : 'bg-canvas text-ink-dim border-border hover:border-border-hi hover:text-ink'
                }`}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>
      <div className="flex-1 min-h-0 min-w-0">
        {renderWorkspaceLeaf(
          focusedSessionId,
          focusedSessionId,
          workspace,
          tab.id,
        )}
      </div>
    </div>
  )
}

function shortLabel(value: string): string {
  const parts = value.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? value
}
