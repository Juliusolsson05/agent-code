import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { BrowserPocketConfig, SessionId } from '@renderer/workspace/types'

import { attachPocket, setPocketSplit } from '../actions'
import { requestPocket } from '../state/pocketBus'
import { useLanePorts } from '../state/lanePortsStore'
import { useSpotlightPocketMode } from '../state/spotlightPocketMode'
import { pocketLayout, type PocketLayout } from './layout'
import { PocketChrome } from './PocketChrome'
import { PocketDrivingStatus } from './PocketDrivingStatus'
import { PocketEmptyState } from './PocketEmptyState'
import { PocketSlot } from './PocketSlot'
import { PocketStrip } from './PocketStrip'

export type PocketPlacement = { surface: 'lane' | 'spotlight'; laneIndex: number | null; focused: boolean; dimmed: boolean }

/**
 * The ONE place a pocket joins an agent's view. Lanes and Spotlight both draw
 * a session through renderWorkspaceLeaf, which wraps EVERY leaf in this — so
 * "show the browser together with the agent in Spotlight" needs no
 * Spotlight-specific data (spec §5.4).
 *
 * WHY every leaf, pocket or not: the agent leaf must sit at the SAME element
 * position whether a pocket exists or not. Wrapping only pocket-bearing leaves
 * switched the element type when ⌘⇧B attached a pocket (or an agent's
 * browser_open did, mid-run), which remounted the whole agent view and tore
 * down its terminal attach and feed (review B #4). This wrapper reads no app
 * settings — only the attachment below does, and only when a pocket exists —
 * so lanes without a pocket pay one div and one ResizeObserver.
 */
export function PocketedLeaf(props: { sessionId: SessionId; workspace: Workspace; placement: PocketPlacement; children: ReactNode }) {
  const pocket = props.workspace.state.sessions[props.sessionId]?.browserPocket
  const browserOnly = useSpotlightPocketMode(s => s.browserOnly) && props.placement.surface === 'spotlight' && pocket?.view === 'open'
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setSize(prev => {
      const r = el.getBoundingClientRect()
      return Math.abs(prev.width - r.width) < 1 && Math.abs(prev.height - r.height) < 1 ? prev : { width: r.width, height: r.height }
    })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const layout = pocket ? pocketLayout(size, pocket.view, props.placement.surface) : null

  return (
    // data-pocket-clip: the guest is fixed-position in the host layer and
    // cannot inherit this lane's overflow:hidden, so its slot reports this box
    // as the clip rectangle.
    <div ref={box} data-pocket-clip className={`flex h-full min-h-0 min-w-0 ${layout === 'side' ? 'flex-row' : 'flex-col'}`}>
      {/* The agent always fills whatever the pocket column leaves. */}
      <div className="min-h-0 min-w-0 overflow-hidden" style={browserOnly ? { flex: '0 0 44px' } : { flex: '1 1 0%' }}>
        {props.children}
      </div>
      {pocket && layout && <PocketAttachment {...props} pocket={pocket} layout={layout} browserOnly={browserOnly} box={box} />}
    </div>
  )
}

function PocketAttachment(props: {
  sessionId: SessionId
  workspace: Workspace
  placement: PocketPlacement
  pocket: BrowserPocketConfig
  layout: PocketLayout
  browserOnly: boolean
  box: React.RefObject<HTMLDivElement | null>
}) {
  const enabled = useAppStore(s => s.settings.browserPocketEnabled)
  const ports = useLanePorts(props.sessionId)
  if (!enabled) return null
  const { pocket, layout, browserOnly } = props
  if (layout === 'strip') return <PocketStrip sessionId={props.sessionId} workspace={props.workspace} />
  const side = layout === 'side'
  const split = pocket.split ?? 0.5
  return (
    <>
      {!browserOnly && <SplitHandle side={side} container={props.box} onFraction={f => props.workspace.updateBrowserPocket(s => setPocketSplit(s, props.sessionId, f))} />}
      <div className="flex min-h-0 min-w-0 flex-col border-border" style={browserOnly ? { flex: '1 1 0%' } : { flex: `0 0 ${split * 100}%` }}>
        <PocketChrome sessionId={props.sessionId} workspace={props.workspace} compact={props.placement.surface === 'lane'} />
        <div className="min-h-0 flex-1">
          <PocketSlot
            pocketId={pocket.pocketId}
            {...props.placement}
            mirrorLabel={shownIn => (shownIn.surface === 'spotlight' ? 'Shown in Spotlight' : `Shown in lane ${(shownIn.laneIndex ?? 0) + 1}`)}
          >
            {!pocket.url && (
              <PocketEmptyState ports={ports} onOpen={url => {
                props.workspace.updateBrowserPocket(s => attachPocket(s, props.sessionId, { url }))
                requestPocket(pocket.pocketId, { type: 'navigate', url })
              }} />
            )}
          </PocketSlot>
        </div>
        <PocketDrivingStatus pocketId={pocket.pocketId} />
      </div>
    </>
  )
}

function SplitHandle({ side, container, onFraction }: { side: boolean; container: React.RefObject<HTMLDivElement | null>; onFraction: (fraction: number) => void }) {
  return (
    <div
      role="separator"
      aria-orientation={side ? 'vertical' : 'horizontal'}
      aria-label="Resize browser pocket"
      className={`${side ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'} flex-shrink-0 bg-border hover:bg-accent`}
      onPointerDown={event => {
        const el = container.current
        if (!el) return
        event.preventDefault()
        const rect = el.getBoundingClientRect()
        // While dragging, the pointer crosses the page; a <webview> would
        // swallow those events (Orca: pointer-events:none on guests during
        // drags). The host listens for this class on <html>.
        document.documentElement.classList.add('pocket-dragging')
        const move = (e: PointerEvent) => onFraction(side ? (rect.right - e.clientX) / rect.width : (rect.bottom - e.clientY) / rect.height)
        const up = () => {
          document.documentElement.classList.remove('pocket-dragging')
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }}
    />
  )
}
