import { useId, useState } from 'react'

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
  const [focusWithin, setFocusWithin] = useState(false)
  const detailsId = useId()
  const patchLive = usePocketLiveStore(s => s.patch)
  if (!pocket) return null
  const open = () => workspace.updateBrowserPocket(s => setPocketView(s, sessionId, 'open'))
  const primary = ports.find(p => p.kind === 'html') ?? ports[0]
  const fetchThumbnail = () => {
    if (pocket.url) void window.api.pocketThumbnail({ pocketId: pocket.pocketId }).then(t => { if (t) patchLive(pocket.pocketId, { thumbnail: t }) }).catch(() => null)
  }
  // Everything the strip's glyphs only HINT at, spelled out (K2-8 / K2-9).
  // These were hover `title`s on non-focusable spans ("● agent", "!", "3 err")
  // and a thumbnail that appeared on mouseenter only, so a keyboard user saw
  // a status they could never expand. Now the same panel opens on hover OR
  // when focus is inside the strip, and the strip's buttons point to it
  // (aria-describedby), so it is read out as well as seen.
  const details = [
    pocket.url ?? 'No page yet',
    live.driving === 'agent' ? `Agent: ${live.drivingAction ?? 'using the browser'}` : null,
    live.driving === 'user-paused' ? 'You took control; the agent is paused.' : null,
    live.failed || live.crashedOut ? `Page failed: ${live.failed?.description ?? 'the page crashed'}` : null,
    live.unseenErrors > 0 ? `${live.unseenErrors} console error${live.unseenErrors === 1 ? '' : 's'} since you last opened the pocket` : null,
    ports.length > 0 ? `Dev servers: ${ports.map(p => `localhost:${p.port} (pid ${p.pid})`).join(', ')}` : null,
  ].filter((line): line is string => line !== null)
  const showDetails = hover || focusWithin
  const describedBy = showDetails ? detailsId : undefined
  const buttonFocus = 'rounded-control outline-none focus-visible:ring-1 focus-visible:ring-focus-ring'
  return (
    <div
      data-testid="pocket-strip"
      className="relative flex h-[22px] flex-shrink-0 items-center gap-2 border-t border-border bg-surface px-2 text-[11px]"
      onMouseEnter={() => {
        setHover(true)
        fetchThumbnail()
      }}
      onMouseLeave={() => setHover(false)}
      onFocus={() => {
        if (!focusWithin) fetchThumbnail()
        setFocusWithin(true)
      }}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusWithin(false)
      }}
    >
      <button type="button" className={`text-ink-dim hover:text-ink ${buttonFocus}`} aria-label="Open browser pocket" aria-describedby={describedBy} title={withChord('Open browser pocket', pocketChord)} onClick={open}>Browser</button>
      {primary && (
        <button
          type="button"
          className={`border border-border px-1 font-code text-[10px] text-ink-dim hover:border-border-hi hover:text-ink ${buttonFocus}`}
          aria-label={`Open localhost:${primary.port} in the pocket`}
          aria-describedby={describedBy}
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
      <button type="button" onClick={open} aria-describedby={describedBy} className={`min-w-0 flex-1 truncate text-left font-code text-ink-dim hover:text-ink ${buttonFocus}`} style={{ direction: 'rtl' }}>
        <span style={{ direction: 'ltr', unicodeBidi: 'plaintext' }}>{pocket.url ?? 'No page yet'}</span>
      </button>
      {live.driving === 'agent' && <span className="text-accent">● agent</span>}
      {live.driving === 'user-paused' && <span className="text-warning">⏸ paused</span>}
      {live.loading && <span className="animate-spin text-ink-dim" aria-hidden="true">⟳</span>}
      {(live.failed || live.crashedOut) && <span className="text-danger" aria-label="Page failed">!</span>}
      {live.unseenErrors > 0 && <span className="text-warning">{live.unseenErrors} err</span>}
      {showDetails && (
        <div
          id={detailsId}
          role="tooltip"
          // Popover chrome like every floating menu (theme shadow; the old
          // hard rgba shadow was a smear on light themes).
          className="rounded-float pointer-events-none absolute bottom-[24px] left-2 z-40 flex w-[320px] flex-col gap-1 overflow-hidden border border-popover-border bg-popover-bg p-1.5 text-[11px] text-ink shadow-[0_8px_24px_var(--theme-shadow-color)]"
        >
          {live.thumbnail ? <img src={live.thumbnail} alt="" className="rounded-control w-full border border-border" /> : null}
          {details.map(line => (
            <div key={line} className="font-code text-[10px] text-ink-dim [overflow-wrap:anywhere]">{line}</div>
          ))}
        </div>
      )}
    </div>
  )
}
