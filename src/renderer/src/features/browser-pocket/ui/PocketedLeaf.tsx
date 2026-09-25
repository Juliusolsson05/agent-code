import { viewportSize } from '@shared/browserPocket/devices'
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { AgentTerminalOwnerVisibilityProvider } from '@renderer/workspace/terminal/AgentTerminalOwnership'
import { reloadSessionWithBuiltInMcpChoice } from '@renderer/workspace/builtInMcpReload'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { BrowserPocketConfig, SessionId } from '@renderer/workspace/types'

import { attachPocket, setPocketSplit, setPocketViewport } from '../actions'
import { requestPocket } from '../state/pocketBus'
import { useLanePorts } from '../state/lanePortsStore'
import { useSpotlightPocketMode } from '../state/spotlightPocketMode'
import { fitViewport, pocketLayout, pocketSplitWidth, SPLITTER_WIDTH, type PocketLayout } from './layout'
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
 * down its terminal attach and feed (review B #4). Visibility changes also
 * release terminal ownership while preserving the mounted conversation.
 */
export function PocketedLeaf(props: { sessionId: SessionId; workspace: Workspace; placement: PocketPlacement; children: ReactNode }) {
  const pocket = props.workspace.state.sessions[props.sessionId]?.browserPocket
  const enabled = useAppStore(s => s.settings.browserPocketEnabled)
  const spotlightBrowserOnly = useSpotlightPocketMode(s => s.browserOnly) && props.placement.surface === 'spotlight' && pocket?.view === 'open'
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

  const layout = pocket && enabled ? pocketLayout(size, pocket.view, props.placement.surface) : null

  const browserOnly = enabled && (spotlightBrowserOnly || layout === 'browser')

  return (
    // data-pocket-clip: the guest is fixed-position in the host layer and
    // cannot inherit this lane's overflow:hidden, so its slot reports this box
    // as the clip rectangle.
    <div ref={box} data-pocket-clip className={`flex h-full w-full min-h-0 min-w-0 ${layout === 'side' ? 'flex-row' : 'flex-col'}`}>
      {/* The agent always fills whatever the pocket column leaves. */}
      <div className="min-h-0 min-w-0 overflow-hidden" style={browserOnly ? { display: 'none' } : { flex: '1 1 0%' }}>
        <AgentTerminalOwnerVisibilityProvider visible={!browserOnly}>{props.children}</AgentTerminalOwnerVisibilityProvider>
      </div>
      {pocket && layout && <PocketAttachment {...props} pocket={pocket} layout={layout} browserOnly={browserOnly} box={box} size={size} />}
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
  size: { width: number; height: number }
  box: React.RefObject<HTMLDivElement | null>
}) {
  const enabled = useAppStore(s => s.settings.browserPocketEnabled)
  const ports = useLanePorts(props.sessionId)
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 })
  const measurePage = useCallback((next: { width: number; height: number }) => setPageSize(prev => prev.width === next.width && prev.height === next.height ? prev : next), [])
  if (!enabled) return null
  const { pocket, layout, browserOnly } = props
  if (layout === 'strip') return <PocketStrip sessionId={props.sessionId} workspace={props.workspace} />
  const width = pocketSplitWidth(props.size.width, pocket.split)
  const viewport = pocket.viewport && pocket.viewport.mode !== 'fill' ? viewportSize(pocket.viewport) : null
  const fit = fitViewport(pageSize, viewport)
  return (
    <>
      {!browserOnly && <SplitHandle width={width} container={props.box} onFraction={f => props.workspace.updateBrowserPocket(s => setPocketSplit(s, props.sessionId, f))} />}
      <div className="flex min-h-0 min-w-0 flex-col border-border" style={browserOnly ? { flex: '1 1 0%' } : { flex: `0 0 ${width}px` }}>
        <PocketChrome sessionId={props.sessionId} workspace={props.workspace} compact={(browserOnly ? props.size.width : width) < 420} inLane={props.placement.surface === 'lane'} browserOnly={browserOnly} />
        <PocketSetup sessionId={props.sessionId} workspace={props.workspace} />
        <div className="min-h-0 flex-1">
          <PocketSlot
            onSize={measurePage}
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
        <div className="flex h-5 shrink-0 items-center justify-between gap-1 border-t border-border px-2 font-code text-[10px] text-muted" title="Page viewport in CSS pixels; device previews scale to fit the available pane">
          <span className="truncate">{Math.round(fit.width)} × {Math.round(fit.height)}{viewport ? ` · ${Math.round(fit.scale * 100)}% preview` : ''}</span>
          {viewport && <button type="button" className="shrink-0 rounded-control outline-none hover:text-ink focus-visible:ring-1 focus-visible:ring-focus-ring" onClick={() => props.workspace.updateBrowserPocket(s => setPocketViewport(s, props.sessionId, { mode: 'fill' }))}>Fit Pane</button>}
        </div>
        <PocketDrivingStatus pocketId={pocket.pocketId} />
      </div>
    </>
  )
}

function SplitHandle({ width, container, onFraction }: { width: number; container: React.RefObject<HTMLDivElement | null>; onFraction: (fraction: number) => void }) {
  const cleanup = useRef<(() => void) | null>(null)
  useLayoutEffect(() => () => cleanup.current?.(), [])
  const resize = (pixels: number) => {
    const rect = container.current?.getBoundingClientRect()
    if (rect) onFraction(pocketSplitWidth(rect.width, pixels / (rect.width - SPLITTER_WIDTH)) / (rect.width - SPLITTER_WIDTH))
  }
  return (
    <div
      role="separator" tabIndex={0} aria-orientation="vertical"
      aria-label="Resize browser pocket" aria-valuenow={Math.round(width)}
      className="w-1 flex-shrink-0 cursor-col-resize bg-border hover:bg-accent focus:bg-accent"
      onKeyDown={event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault(); event.stopPropagation()
        resize(width + (event.key === 'ArrowLeft' ? 24 : -24))
      }}
      onPointerDown={event => {
        if (event.button !== 0) return
        const rect = container.current?.getBoundingClientRect()
        if (!rect) return
        event.preventDefault()
        cleanup.current?.()
        // Guests consume pointer events. Disable hit testing for the drag,
        // and release it on cancellation, lost focus AND unmount; otherwise
        // one interrupted drag makes every browser permanently unclickable.
        document.documentElement.classList.add('pocket-dragging')
        const move = (e: PointerEvent) => resize(rect.right - e.clientX)
        const up = () => {
          document.documentElement.classList.remove('pocket-dragging')
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          window.removeEventListener('pointercancel', up)
          window.removeEventListener('blur', up)
          cleanup.current = null
        }
        cleanup.current = up
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        window.addEventListener('pointercancel', up)
        window.addEventListener('blur', up)
      }}
    />
  )
}

/** Enabling the feature and attaching tools are different operations. Show
 * the state of THIS running agent, rather than suggesting another global
 * toggle or silently restarting a conversation while it is doing work. */
function PocketSetup({ sessionId, workspace }: { sessionId: SessionId; workspace: Workspace }) {
  const [connecting, setConnecting] = useState(false)
  const meta = workspace.state.sessions[sessionId]
  if (meta?.builtInMcpDomains?.includes('browser')) return null
  return <button type="button" className="shrink-0 border-b border-border bg-surface px-2 py-1 text-left text-[11px] text-ink-dim hover:text-ink" disabled={connecting} onClick={() => {
    setConnecting(true)
    void reloadSessionWithBuiltInMcpChoice(workspace, sessionId, 'browser', true, { reloaded: 'Browser tools connected', failed: 'Could not connect browser tools.' }).finally(() => setConnecting(false))
  }}>
    {connecting ? 'Connecting…' : 'Connect Browser Tools · Reload Agent'}
  </button>
}
