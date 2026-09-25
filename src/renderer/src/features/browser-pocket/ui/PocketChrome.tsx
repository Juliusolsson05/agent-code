import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Input } from '@renderer/components/ui/input'

import { normalisePocketUrl } from '@shared/browserPocket/url'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { SessionId } from '@renderer/workspace/types'
import { useGlobalToast } from '@renderer/ui/GlobalToastContext'

import { setPocketView } from '../actions'
import { requestPocket } from '../state/pocketBus'
import { usePocketLive } from '../state/pocketLiveStore'
import { useLanePorts } from '../state/lanePortsStore'
import { useSpotlightPocketMode } from '../state/spotlightPocketMode'
import { PocketMenu } from './PocketMenu'

const BTN = 'flex h-7 min-w-7 items-center justify-center rounded-control shrink-0 px-1 text-ink-dim hover:bg-canvas hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent'

/** Keep the address usable in narrow lanes: secondary actions live in the
 * native menu. Closing the visible pane preserves cookies and history. */
export function PocketChrome({ sessionId, workspace, compact = false, inLane = false, browserOnly = false }: { sessionId: SessionId; workspace: Workspace; compact?: boolean; inLane?: boolean; browserOnly?: boolean }) {
  const pocket = workspace.state.sessions[sessionId]?.browserPocket
  const live = usePocketLive(pocket?.pocketId)
  const ports = useLanePorts(sessionId)
  const [draft, setDraft] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const { showToast } = useGlobalToast()

  // ⌘L inside the page and the "Focus Address Bar" command both land here.
  useEffect(() => {
    if (live.focusAddressTick > 0) { input.current?.focus(); input.current?.select() }
  }, [live.focusAddressTick])

  if (!pocket) return null
  const go = () => {
    const result = normalisePocketUrl(draft ?? pocket.url ?? '')
    setDraft(null)
    input.current?.blur()
    if (!result.ok) {
      if (result.reason !== 'empty') showToast(result.reason === 'scheme' ? 'The browser pocket only opens http and https pages.' : 'That is not a URL the pocket can open.')
      return
    }
    requestPocket(pocket.pocketId, { type: 'navigate', url: result.url })
  }
  const agentDriving = live.driving === 'agent'
  return (
    <div className="relative flex h-9 flex-shrink-0 items-center gap-0.5 border-b border-border bg-surface px-1 text-[11px]">
      {!(compact && browserOnly) && <button type="button" className={BTN} aria-label="Back" title="Back" disabled={!live.canGoBack} onClick={() => requestPocket(pocket.pocketId, { type: 'back' })}><ControlIcon><path d="m14 5-7 7 7 7" /></ControlIcon></button>}

      <button type="button" className={BTN} aria-label={live.loading ? 'Stop loading' : 'Reload'} title={live.loading ? 'Stop loading' : 'Reload (Shift-click: without cache)'} onClick={e => requestPocket(pocket.pocketId, live.loading ? { type: 'stop' } : { type: 'reload', hard: e.shiftKey })}>
        <ControlIcon>{live.loading ? <rect x="6" y="6" width="12" height="12" rx="1" /> : <><path d="M20 7v5h-5" /><path d="M19.6 12a8 8 0 1 0-2.2 5.7M20 12l-2-5" /></>}</ControlIcon>
      </button>
      <Input
        ref={input}
        aria-label="Address"
        spellCheck={false}
        className="mx-1 h-7 min-w-0 flex-1 px-2"
        value={draft ?? pocket.url ?? ''}
        placeholder={ports[0] ? `localhost:${ports[0].port}` : 'localhost:5173 or a URL'}
        onFocus={e => e.currentTarget.select()}
        onChange={e => setDraft(e.currentTarget.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') go()
          else if (e.key === 'Escape') { setDraft(null); e.currentTarget.blur() }
          // Keys typed here belong to the address bar, never to the app's
          // lane shortcuts.
          e.stopPropagation()
        }}
        onBlur={() => setDraft(null)}
      />
      {!compact && <button type="button" className={BTN} aria-label="Pick element for agent" title="Pick an element to reference in the agent’s composer (Esc cancels)" aria-pressed={live.picking} disabled={!pocket.url} onClick={() => requestPocket(pocket.pocketId, { type: 'pick' })}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5M9 9l4 11 2-5 5-2Z" /></svg></button>}
      {inLane && <button type="button" className={BTN} aria-label="Expand browser beside agent" title="Show agent and browser in Spotlight" onClick={() => { useSpotlightPocketMode.getState().set(false); workspace.setSpotlightTarget(sessionId) }}><ControlIcon><path d="M14 3h7v7M21 3l-7 7M10 21H3v-7M3 21l7-7" /></ControlIcon></button>}
      <PocketMenu sessionId={sessionId} workspace={workspace} buttonClass={BTN} />
      <button type="button" className={`${BTN} shrink-0`} aria-label={browserOnly ? 'Show agent' : 'Collapse browser pocket'} title={browserOnly ? 'Return to agent (browser stays open)' : 'Collapse browser pocket'} onClick={() => workspace.updateBrowserPocket(s => setPocketView(s, sessionId, 'collapsed'))}>{browserOnly ? 'Agent' : <ControlIcon><path d="M5 17h14" /></ControlIcon>}</button>
      {/* 2 px progress bar along the bottom edge while loading. */}
      {live.loading && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-accent" />}
      {agentDriving && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-accent" />}
    </div>
  )
}

// A small consistent SVG set stays crisp at UI scale. Font glyphs varied by
// platform and made the old toolbar's navigation controls hard to recognize.
function ControlIcon({ children }: { children: ReactNode }) {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
}
