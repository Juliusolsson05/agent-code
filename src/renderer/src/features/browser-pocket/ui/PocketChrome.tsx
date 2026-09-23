import { useEffect, useRef, useState } from 'react'

import { normalisePocketUrl } from '@shared/browserPocket/url'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { SessionId } from '@renderer/workspace/types'
import { useGlobalToast } from '@renderer/ui/GlobalToast'

import { setPocketView } from '../actions'
import { detachAndForget } from './detach'
import { requestPocket } from '../state/pocketBus'
import { usePocketLive } from '../state/pocketLiveStore'
import { useLanePorts } from '../state/lanePortsStore'
import { PocketMenu } from './PocketMenu'

const BTN = 'flex h-6 min-w-6 items-center justify-center rounded-control px-1 text-ink-dim hover:bg-canvas hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent'

/** The pocket's 32 px chrome row (spec §4.4). */
export function PocketChrome({ sessionId, workspace, compact = false }: { sessionId: SessionId; workspace: Workspace; compact?: boolean }) {
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
    const result = normalisePocketUrl(draft ?? '')
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
    <div className={`relative flex ${compact ? 'h-7' : 'h-8'} flex-shrink-0 items-center gap-0.5 border-b border-border bg-surface px-1 text-[11px]`}>
      <button type="button" className={BTN} aria-label="Back" title="Back" disabled={!live.canGoBack} onClick={() => requestPocket(pocket.pocketId, { type: 'back' })}>◀</button>
      <button type="button" className={BTN} aria-label="Forward" title="Forward" disabled={!live.canGoForward} onClick={() => requestPocket(pocket.pocketId, { type: 'forward' })}>▶</button>
      <button type="button" className={BTN} aria-label="Reload" title="Reload (⇧-click: hard reload)" onClick={e => requestPocket(pocket.pocketId, { type: 'reload', hard: e.shiftKey })}>
        {live.loading ? <span className="inline-block animate-spin">⟳</span> : '↻'}
      </button>
      <input
        ref={input}
        aria-label="Address"
        spellCheck={false}
        className="mx-1 h-6 min-w-0 flex-1 rounded-control border border-border bg-canvas px-2 font-code text-[11px] text-ink outline-none focus:border-accent"
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
      <button type="button" className={BTN} aria-label="Pick element for agent" title="Pick an element for the agent (⌘⇧S in the page)" disabled={!pocket.url} aria-pressed={live.picking} onClick={() => requestPocket(pocket.pocketId, { type: 'pick' })}>◎</button>
      <button type="button" className={BTN} aria-label="Open in browser" title="Open in your browser" disabled={!pocket.url} onClick={() => requestPocket(pocket.pocketId, { type: 'open-external' })}>↗</button>
      <PocketMenu sessionId={sessionId} workspace={workspace} buttonClass={BTN} />
      <button type="button" className={BTN} aria-label="Collapse browser pocket" title="Collapse to the lane strip" onClick={() => workspace.updateBrowserPocket(s => setPocketView(s, sessionId, 'collapsed'))}>▁</button>
      <button type="button" className={BTN} aria-label="Detach browser pocket" title="Detach browser pocket" onClick={() => detachAndForget(workspace, sessionId)}>✕</button>
      {/* 2 px progress bar along the bottom edge while loading. */}
      {live.loading && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-accent" />}
      {agentDriving && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-accent" />}
    </div>
  )
}
