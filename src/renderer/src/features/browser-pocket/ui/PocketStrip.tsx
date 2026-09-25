import { useState } from 'react'

import { useCommandChordLabel, withChord } from '@renderer/features/command-keybindings/useCommandChord'

import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { SessionId } from '@renderer/workspace/types'

import { attachPocket, setPocketView } from '../actions'
import { requestPocket } from '../state/pocketBus'
import { usePocketLive, usePocketLiveStore } from '../state/pocketLiveStore'
import { useLanePorts } from '../state/lanePortsStore'

/**
 * The 22 px collapsed pocket in a lane (spec §4.1): glanceable, never a
 * full browser. It is the default after an AGENT opens a pocket — the user's
 * view is never replaced by a panel they did not ask for. An explicit open
 * gets a usable full pane or side-by-side layout, even in a narrow lane.
 */
export function PocketStrip({ sessionId, workspace }: { sessionId: SessionId; workspace: Workspace }) {
  const pocket = workspace.state.sessions[sessionId]?.browserPocket
  const pocketChord = useCommandChordLabel('toggle-browser-pocket')
  const live = usePocketLive(pocket?.pocketId)
  const ports = useLanePorts(sessionId)
  const [hover, setHover] = useState(false)
  const patchLive = usePocketLiveStore(s => s.patch)
  if (!pocket) return null
  const open = () => workspace.updateBrowserPocket(s => setPocketView(s, sessionId, 'open'))
  const primary = ports.find(p => p.kind === 'html') ?? ports[0]
  return (
    <div
      data-testid="pocket-strip"
      className="relative flex h-[22px] flex-shrink-0 items-center gap-2 border-t border-border bg-surface px-2 text-[11px]"
      onMouseEnter={() => {
        setHover(true)
        if (pocket.url) void window.api.pocketThumbnail({ pocketId: pocket.pocketId }).then(t => { if (t) patchLive(pocket.pocketId, { thumbnail: t }) }).catch(() => null)
      }}
      onMouseLeave={() => setHover(false)}
    >
      <button type="button" className="text-ink-dim hover:text-ink" aria-label="Open browser pocket" title={withChord('Open browser pocket', pocketChord)} onClick={open}>Browser</button>
      {primary && (
        <button
          type="button"
          className="rounded-control border border-border px-1 font-code text-[10px] text-ink-dim hover:border-border-hi hover:text-ink"
          title={ports.map(p => `localhost:${p.port} (pid ${p.pid})`).join('\n')}
          onClick={() => {
            workspace.updateBrowserPocket(s => attachPocket(s, sessionId, { url: primary.url, view: 'open' }))
            if (pocket.url !== primary.url) requestPocket(pocket.pocketId, { type: 'navigate', url: primary.url })
          }}
        >
          :{primary.port}{ports.length > 1 ? ` +${ports.length - 1}` : ''}
        </button>
      )}
      {/* Truncate from the LEFT so the path — the part that differs between
          pages of one dev server — stays visible. */}
      <button type="button" onClick={open} className="min-w-0 flex-1 truncate text-left font-code text-ink-dim hover:text-ink" style={{ direction: 'rtl' }} title={pocket.url}>
        <span style={{ direction: 'ltr', unicodeBidi: 'plaintext' }}>{pocket.url ?? 'No page yet'}</span>
      </button>
      {live.driving === 'agent' && <span className="text-accent" title={live.drivingAction ?? 'Agent is using the browser'}>● agent</span>}
      {live.driving === 'user-paused' && <span className="text-warning" title="You took control; the agent is paused">⏸ paused</span>}
      {live.loading && <span className="animate-spin text-ink-dim">⟳</span>}
      {(live.failed || live.crashedOut) && <span className="text-danger" title={live.failed?.description ?? 'The page crashed'}>!</span>}
      {live.unseenErrors > 0 && <span className="text-warning" title="Console errors since you last opened the pocket">{live.unseenErrors} err</span>}
      {hover && live.thumbnail && (
        <img src={live.thumbnail} alt="" className="rounded-control pointer-events-none absolute bottom-[24px] left-2 z-40 w-[320px] border border-border-hi shadow-[0_8px_24px_rgba(0,0,0,0.35)]" />
      )}
    </div>
  )
}
