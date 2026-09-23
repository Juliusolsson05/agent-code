import { memo, useEffect, useMemo, useRef, useState } from 'react'

import { viewportSize } from '@shared/browserPocket/devices'
import { isAllowedTopLevelUrl } from '@shared/browserPocket/url'
import { useAppStore } from '@renderer/app-state/hooks'
import { useGlobalToast } from '@renderer/ui/GlobalToast'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { BrowserPocketConfig, SessionId } from '@renderer/workspace/types'

import { setPocketUrl } from '../actions'
import { nextCrashDelay, pocketsToSleep } from '../placement/lifecycle'
import { usePlacementStore } from '../placement/placementStore'
import { intersect, resolvePlacement, type Placement } from '../placement/resolvePlacement'
import { onPocketRequest, type PocketRequest } from '../state/pocketBus'
import { usePocketLive, usePocketLiveStore } from '../state/pocketLiveStore'
import { fitViewport } from './layout'
import { usePocketBridges } from './usePocketBridges'
import type { WebviewElement } from './webviewElement'

/**
 * Owns every pocket's <webview>. Mounted ONCE beside <main>, outside
 * RetainedWorkspaceSurface, so nothing a layout change or a takeover does can
 * unmount a guest (a detached <webview> is destroyed and reloads). Guests are
 * keyed by pocketId: SessionIds change on reload, lane indices on every splice.
 *
 * WHY there is no wrapping fixed container: `position: fixed` creates a
 * stacking context, and a guest that must keep painting while hidden has to
 * sit at z-index −1 in the ROOT stacking context, behind the app's opaque
 * surfaces (Chromium stops compositing a guest that is fully outside the
 * window — T3 Code hostedBrowserWebviewStyle.ts). So each guest's own wrapper
 * is the fixed element and carries its own z-index.
 */
export function BrowserPocketHost({ workspace }: { workspace: Workspace }) {
  const enabled = useAppStore(s => s.settings.browserPocketEnabled)
  usePocketBridges(workspace, enabled)

  const pockets = useMemo(() => {
    if (!enabled) return []
    return Object.entries(workspace.state.sessions)
      .filter(([, meta]) => meta.browserPocket)
      .map(([sessionId, meta]) => ({ sessionId: sessionId as SessionId, pocket: meta.browserPocket!, projectId: meta.projectId as string | undefined }))
  }, [workspace.state.sessions, enabled])

  // Runtime entries for pockets that were detached or whose session closed.
  const forgetPlacement = usePlacementStore(s => s.forget)
  const forgetLive = usePocketLiveStore(s => s.forget)
  const known = useRef(new Set<string>())
  useEffect(() => {
    const alive = new Set(pockets.map(p => p.pocket.pocketId))
    for (const id of known.current) if (!alive.has(id)) { forgetPlacement(id); forgetLive(id) }
    known.current = alive
  }, [pockets, forgetPlacement, forgetLive])

  useSleepPolicy(pockets.map(p => p.pocket.pocketId))

  return (
    <>
      {/* A <webview> swallows pointer events; during a split/lane drag the
          pointer crosses pages, so guests go inert (Orca's fix). */}
      <style>{'.pocket-dragging [data-pocket-guest]{pointer-events:none!important}'}</style>
      {pockets.map(p => <HostedPocket key={p.pocket.pocketId} {...p} workspace={workspace} />)}
    </>
  )
}

const HostedPocket = memo(function HostedPocket({ sessionId, pocket, projectId, workspace }: {
  sessionId: SessionId
  pocket: BrowserPocketConfig
  projectId: string | undefined
  workspace: Workspace
}) {
  const slots = usePlacementStore(s => s.slots[pocket.pocketId])
  const mustPaint = usePlacementStore(s => (s.paintLeases[pocket.pocketId] ?? 0) > 0)
  const lastSize = usePlacementStore(s => s.lastSize[pocket.pocketId] ?? null)
  const noteShown = usePlacementStore(s => s.noteShown)
  const live = usePocketLive(pocket.pocketId)
  const patchLive = usePocketLiveStore(s => s.patch)
  const { showToast } = useGlobalToast()
  const [partition, setPartition] = useState<string | null>(null)
  const [created, setCreated] = useState(false)
  const element = useRef<WebviewElement | null>(null)
  const registered = useRef(false)
  // `src` is read ONCE per guest: React re-setting the attribute on every
  // render would navigate the page. Later navigations go through loadURL.
  const initialSrc = useRef<string>('about:blank')

  // An agent action needs a painting page even when nothing shows it: CDP
  // snapshots and screenshots of a non-composited guest hang or come back
  // empty (T3 Code UnknownVizError). The picker needs the same.
  const needsPaint = mustPaint || live.driving === 'agent' || live.picking
  const placement: Placement = resolvePlacement({
    slots: Object.values(slots ?? {}),
    alive: created && !live.asleep,
    mustPaint: needsPaint,
    lastSize,
  })
  usePlacementTrace(pocket.pocketId, slots, placement)
  const wantsGuest = placement.mode !== 'absent' && !live.crashedOut && (Boolean(pocket.url) || needsPaint)

  // Lazy creation: a restored pocket creates no guest (and no renderer
  // process) until it is shown or an agent needs it.
  useEffect(() => {
    if (wantsGuest && !created) { initialSrc.current = pocket.url && isAllowedTopLevelUrl(pocket.url) ? pocket.url : 'about:blank'; setCreated(true) }
    if (!wantsGuest && live.asleep && created) setCreated(false)
    // Wake a slept pocket the moment a slot shows it, not on the next tick of
    // the sleep timer.
    if (live.asleep && placement.mode === 'shown') patchLive(pocket.pocketId, { asleep: false })
  }, [wantsGuest, created, live.asleep, pocket.url, placement.mode, pocket.pocketId, patchLive])

  // The partition is fixed at attach time, so a profile switch needs a new
  // guest: fetching a new name here remounts it (the key below includes it).
  useEffect(() => {
    if (!created) return
    let cancelled = false
    void window.api.pocketPartition({ pocketId: pocket.pocketId, profile: pocket.profile, ...(projectId ? { projectId } : {}) })
      .then(p => { if (!cancelled) setPartition(p) })
    return () => { cancelled = true }
  }, [created, pocket.pocketId, pocket.profile, projectId])

  // Keep main's pocket → session mapping current across SessionId remaps
  // (reload / provider switch keep the pocketId and change the session).
  useEffect(() => {
    const el = element.current
    if (el && registered.current) void window.api.registerPocketGuest({ pocketId: pocket.pocketId, sessionId, webContentsId: el.getWebContentsId() })
  }, [sessionId, pocket.pocketId])

  // Colour scheme and zoom are page emulation, applied by main over CDP /
  // setZoomFactor; the device viewport is applied here by sizing the element.
  useEffect(() => {
    if (!registered.current) return
    void window.api.applyPocketEmulation({ pocketId: pocket.pocketId, emulation: { colorScheme: pocket.colorScheme ?? null, zoom: pocket.zoom ?? 1 } })
  }, [pocket.pocketId, pocket.colorScheme, pocket.zoom, live.generation])

  // Bus: commands, chrome row, main's page-local chords.
  useEffect(() => onPocketRequest((pocketId, request) => {
    if (pocketId !== pocket.pocketId) return
    handleRequest(request, element.current, pocket, sessionId, workspace, patchLive, showToast)
  }), [pocket, sessionId, workspace, patchLive, showToast])

  const shown = placement.mode === 'shown'
  useEffect(() => {
    if (placement.mode === 'shown') {
      noteShown(pocket.pocketId, { width: placement.rect.width, height: placement.rect.height }, Date.now())
      if (live.unseenErrors) patchLive(pocket.pocketId, { unseenErrors: 0 })
    }
  })
  // A thumbnail for mirrors and the strip's hover preview, taken as the page
  // leaves the screen (the last moment it is guaranteed to be painted).
  const wasShown = useRef(false)
  useEffect(() => {
    if (wasShown.current && !shown && registered.current) {
      void window.api.pocketThumbnail({ pocketId: pocket.pocketId }).then(t => { if (t) patchLive(pocket.pocketId, { thumbnail: t }) }).catch(() => {})
    }
    wasShown.current = shown
  }, [shown, pocket.pocketId, patchLive])

  // Attach page events once per guest.
  useEffect(() => {
    const el = element.current
    if (!el || !partition) return
    registered.current = false
    const register = () => {
      void window.api.registerPocketGuest({ pocketId: pocket.pocketId, sessionId, webContentsId: el.getWebContentsId() }).then(r => {
        registered.current = r.ok
        if (r.ok) void window.api.applyPocketEmulation({ pocketId: pocket.pocketId, emulation: { colorScheme: pocket.colorScheme ?? null, zoom: pocket.zoom ?? 1 } })
      })
    }
    const onNav = () => {
      patchLive(pocket.pocketId, { canGoBack: el.canGoBack(), canGoForward: el.canGoForward() })
      const url = el.getURL()
      if (url && isAllowedTopLevelUrl(url)) workspace.updateBrowserPocket(s => setPocketUrl(s, sessionId, url))
    }
    const onCommit = (e: Event) => { if ((e as unknown as { isMainFrame?: boolean }).isMainFrame !== false) patchLive(pocket.pocketId, { failed: null }); onNav() }
    const onStart = () => patchLive(pocket.pocketId, { loading: true })
    const onStop = () => patchLive(pocket.pocketId, { loading: false })
    const onTitle = (e: Event) => patchLive(pocket.pocketId, { title: (e as unknown as { title: string }).title })
    const onFail = (e: Event) => {
      const f = e as unknown as { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean }
      // -3 is ERR_ABORTED: a navigation superseded by another, not a failure.
      if (f.isMainFrame && f.errorCode !== -3) patchLive(pocket.pocketId, { failed: { code: String(f.errorCode), description: f.errorDescription, url: f.validatedURL }, loading: false })
    }
    const onConsole = (e: Event) => {
      const c = e as unknown as { level: number | string }
      if (c.level === 3 || c.level === 'error') patchLive(pocket.pocketId, prev => ({ unseenErrors: prev.unseenErrors + 1 }))
    }
    const onGone = () => {
      registered.current = false
      const now = Date.now()
      const crashes = [...usePocketLiveStore.getState().live[pocket.pocketId]?.crashes ?? [], now].filter(t => now - t < 30_000)
      const delay = nextCrashDelay(crashes.slice(0, -1), now)
      patchLive(pocket.pocketId, { crashes, loading: false })
      if (delay === null) { patchLive(pocket.pocketId, { crashedOut: true }); return }
      setTimeout(() => patchLive(pocket.pocketId, prev => ({ generation: prev.generation + 1 })), delay)
    }
    el.addEventListener('dom-ready', register, { once: true })
    el.addEventListener('did-navigate', onCommit)
    el.addEventListener('did-navigate-in-page', onNav)
    el.addEventListener('did-start-loading', onStart)
    el.addEventListener('did-stop-loading', onStop)
    el.addEventListener('page-title-updated', onTitle)
    el.addEventListener('did-fail-load', onFail)
    el.addEventListener('console-message', onConsole)
    el.addEventListener('render-process-gone', onGone)
    return () => {
      el.removeEventListener('dom-ready', register)
      el.removeEventListener('did-navigate', onCommit)
      el.removeEventListener('did-navigate-in-page', onNav)
      el.removeEventListener('did-start-loading', onStart)
      el.removeEventListener('did-stop-loading', onStop)
      el.removeEventListener('page-title-updated', onTitle)
      el.removeEventListener('did-fail-load', onFail)
      el.removeEventListener('console-message', onConsole)
      el.removeEventListener('render-process-gone', onGone)
      // Main detaches the debugger BEFORE the guest is destroyed
      // (electron#53819: destroying a webview with an attached debugger is a
      // main-process use-after-free).
      registered.current = false
      void window.api.unregisterPocketGuest({ pocketId: pocket.pocketId })
    }
    // sessionId deliberately excluded: a remap re-registers (effect above)
    // instead of tearing the page's listeners down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partition, live.generation, pocket.pocketId])

  if (!created || !partition) return null

  const viewport = pocket.viewport && pocket.viewport.mode !== 'fill' ? viewportSize(pocket.viewport) : null
  const style = wrapperStyle(placement, viewport)
  const fit = placement.mode === 'shown' ? fitViewport(placement.rect, viewport) : null
  return (
    <div data-pocket-guest style={style} aria-hidden={placement.mode !== 'shown'}>
      <webview
        key={`${partition}#${live.generation}`}
        ref={el => { element.current = el as unknown as WebviewElement | null }}
        partition={partition}
        src={initialSrc.current}
        style={fit && viewport
          ? { position: 'absolute', left: fit.offsetX, top: fit.offsetY, width: fit.width, height: fit.height, transform: `scale(${fit.scale})`, transformOrigin: '0 0', display: 'flex' }
          : { width: '100%', height: '100%', display: 'flex' }}
      />
      {placement.mode === 'shown' && <GuestOverlays pocketId={pocket.pocketId} url={pocket.url} />}
    </div>
  )
})

/** Failure, crash and agent-cursor overlays drawn ABOVE the page. */
function GuestOverlays({ pocketId, url }: { pocketId: string; url?: string }) {
  const live = usePocketLive(pocketId)
  const patchLive = usePocketLiveStore(s => s.patch)
  const cursorFresh = live.driving === 'agent' && live.drivingPoint && Date.now() - live.drivingAt < 2500
  return (
    <>
      {live.driving === 'agent' && <div className="pointer-events-none absolute inset-0 shadow-[inset_0_0_0_2px_var(--color-accent)]" />}
      {cursorFresh && (
        <div className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-accent/30"
          style={{ left: live.drivingPoint!.x, top: live.drivingPoint!.y }} />
      )}
      {live.failed && !live.loading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-canvas p-6 text-center text-[12px] text-ink-dim">
          <div className="text-[14px] text-ink">Can't reach {hostOf(live.failed.url || url)}</div>
          <div className="font-code text-muted">{live.failed.description}</div>
          <button type="button" className="rounded-control border border-border px-2 py-1 hover:border-border-hi hover:text-ink" onClick={() => patchLive(pocketId, { failed: null, generation: live.generation + 1 })}>Retry</button>
        </div>
      )}
      {live.crashedOut && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-canvas p-6 text-center text-[12px] text-ink-dim">
          <div className="text-[14px] text-ink">This page crashed repeatedly</div>
          <button type="button" className="rounded-control border border-border px-2 py-1 hover:border-border-hi hover:text-ink" onClick={() => patchLive(pocketId, { crashedOut: false, crashes: [], generation: live.generation + 1 })}>Reload</button>
        </div>
      )}
    </>
  )
}

function wrapperStyle(placement: Placement, viewport: { width: number; height: number } | null): React.CSSProperties {
  if (placement.mode === 'shown') {
    const { rect } = placement
    const c = intersect(rect, placement.clip)
    // clip-path in the element's own coordinates: the lane box may cut the
    // slot (a row mid-resize), and a fixed guest cannot inherit overflow.
    const clipPath = c ? `inset(${c.y - rect.y}px ${rect.x + rect.width - (c.x + c.width)}px ${rect.y + rect.height - (c.y + c.height)}px ${c.x - rect.x}px)` : undefined
    return {
      position: 'fixed', left: rect.x, top: rect.y, width: rect.width, height: rect.height, zIndex: 20,
      clipPath, overflow: 'hidden', background: viewport ? 'var(--color-canvas)' : undefined,
      // The unfocused-lane dim overlay lives in the lane and cannot cover a
      // guest in this layer, so the guest dims itself.
      filter: placement.dimmed ? 'brightness(0.6)' : undefined,
    }
  }
  const size = placement.mode === 'parked' ? placement.size : { width: 1280, height: 800 }
  const paint = placement.mode === 'parked' && placement.mustPaint
  // Never display:none (guests blank or keep stale sizes, electron#8277) and
  // never visibility:hidden (can permanently blank a macOS guest on Electron
  // 43 per T3 Code). Painting-parked = inside the window behind the app;
  // otherwise far off-screen.
  return {
    position: 'fixed', width: size.width, height: size.height, zIndex: -1, pointerEvents: 'none',
    left: paint ? 0 : -100_000, top: paint ? 0 : -100_000,
  }
}

function handleRequest(
  request: PocketRequest,
  el: WebviewElement | null,
  pocket: BrowserPocketConfig,
  sessionId: SessionId,
  workspace: Workspace,
  patchLive: ReturnType<typeof usePocketLiveStore.getState>['patch'],
  showToast: (m: string) => void,
): void {
  switch (request.type) {
    case 'focus-address':
      patchLive(pocket.pocketId, prev => ({ focusAddressTick: prev.focusAddressTick + 1 }))
      return
    case 'open-external':
      if (pocket.url) void window.api.openRenderedExternalUrl({ url: pocket.url }).then(r => { if (!r.ok) showToast('Could not open that page in your browser') })
      return
    case 'navigate':
      if (!isAllowedTopLevelUrl(request.url)) return
      workspace.updateBrowserPocket(s => setPocketUrl(s, sessionId, request.url))
      patchLive(pocket.pocketId, { failed: null })
      // No guest yet (first URL of an empty pocket): the url write above makes
      // the host create one with this src.
      if (el) void el.loadURL(request.url).catch(() => {})
      return
    case 'pick':
      void import('./pick').then(m => m.pickIntoComposer(pocket.pocketId, sessionId, workspace, patchLive, showToast))
      return
  }
  if (!el) return
  switch (request.type) {
    case 'reload': if (request.hard) el.reloadIgnoringCache(); else el.reload(); return
    case 'back': if (el.canGoBack()) el.goBack(); return
    case 'forward': if (el.canGoForward()) el.goForward(); return
    case 'devtools': el.openDevTools(); return
  }
}

function useSleepPolicy(pocketIds: string[]): void {
  useEffect(() => {
    if (pocketIds.length === 0) return
    const timer = setInterval(() => {
      const placement = usePlacementStore.getState()
      const liveStore = usePocketLiveStore.getState()
      const now = Date.now()
      const input = pocketIds.filter(id => !liveStore.live[id]?.asleep).map(id => ({
        pocketId: id,
        lastVisibleAt: placement.lastVisibleAt[id] ?? now,
        visible: Object.values(placement.slots[id] ?? {}).some(s => s.visible && (s.rect?.width ?? 0) > 0),
        agentLease: (placement.paintLeases[id] ?? 0) > 0 || (liveStore.live[id]?.driving != null && now - (liveStore.live[id]?.drivingAt ?? 0) < 30_000),
      }))
      for (const id of pocketsToSleep(input, now)) liveStore.patch(id, { asleep: true })
      // Wake anything that became visible again.
      for (const id of pocketIds) {
        if (liveStore.live[id]?.asleep && Object.values(placement.slots[id] ?? {}).some(s => s.visible)) liveStore.patch(id, { asleep: false })
      }
    }, 5_000)
    return () => clearInterval(timer)
  }, [pocketIds.join('|')])
}

function hostOf(url: string | undefined): string {
  try { return url ? new URL(url).host : 'the page' } catch { return url ?? 'the page' }
}

/**
 * Dev-only placement trace (decomposition Stage 6 → U7). With
 * `localStorage['agentCode.pocketTrace'] = '1'`, every placement change logs
 * the slot reports that produced it. Those traces, recorded in the real app,
 * replace the provisional mount sequences in placement/resolvePlacement.test.ts.
 * Off by default and never persisted anywhere.
 */
function usePlacementTrace(pocketId: string, slots: Record<string, unknown> | undefined, placement: Placement): void {
  const last = useRef('')
  useEffect(() => {
    let on = false
    try { on = window.localStorage.getItem('agentCode.pocketTrace') === '1' } catch { /* storage blocked */ }
    if (!on) return
    const key = JSON.stringify({ slots, placement: placement.mode === 'shown' ? { mode: 'shown', slotKey: placement.slotKey } : { mode: placement.mode } })
    if (key === last.current) return
    last.current = key
    console.debug('[pocket-trace]', JSON.stringify({ pocketId, at: Date.now(), slots, placement }))
  })
}
