import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { SessionId } from '@renderer/workspace/types'

import { attachPocket } from '../actions'
import { useLanePorts } from '../state/lanePortsStore'

/**
 * The discovery path (spec §4.6): an agent WITHOUT a pocket whose processes
 * are serving a page shows a `:5173` chip in its lane; one click attaches a
 * pocket there. The user runs `npm run dev` (or the agent does), the chip
 * appears, one click shows it — no port guessing across worktrees.
 * Agents that already have a pocket show their ports in the pocket instead.
 */
export function LanePortChip({ sessionId, workspace }: { sessionId: SessionId; workspace: Workspace }) {
  // No settings read: ports only exist while the feature is on (the renderer
  // sends main an empty watch plan when it is off, and the watcher clears the
  // chips), so "has ports" already implies "enabled".
  const ports = useLanePorts(sessionId)
  const hasPocket = Boolean(workspace.state.sessions[sessionId]?.browserPocket)
  const primary = ports.find(p => p.kind === 'html')
  if (hasPocket || !primary) return null
  return (
    <button
      type="button"
      className="rounded-control absolute bottom-1.5 right-2 z-10 border border-border bg-surface px-1.5 py-0.5 font-code text-[10px] text-ink-dim shadow-sm hover:border-accent hover:text-ink"
      title={`Open localhost:${primary.port} in a browser pocket for this agent${ports.length > 1 ? `\nAlso serving: ${ports.filter(p => p !== primary).map(p => `:${p.port}`).join(' ')}` : ''}`}
      onClick={event => {
        event.stopPropagation()
        workspace.updateBrowserPocket(s => attachPocket(s, sessionId, { url: primary.url, view: 'open' }))
      }}
    >
      ◧ :{primary.port}{ports.filter(p => p.kind === 'html').length > 1 ? ` +${ports.filter(p => p.kind === 'html').length - 1}` : ''}
    </button>
  )
}
