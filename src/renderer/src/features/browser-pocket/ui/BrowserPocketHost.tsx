import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@renderer/components/ui/button'

import { viewportSize } from '@shared/browserPocket/devices'
import { isAllowedTopLevelUrl } from '@shared/browserPocket/url'
import { useAppStore } from '@renderer/app-state/hooks'
import { useGlobalToast } from '@renderer/ui/GlobalToastContext'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { BrowserPocketConfig, SessionId } from '@renderer/workspace/types'

import { setPocketUrl } from '../actions'
import { nextCrashDelay, pocketsToSleep } from '../placement/lifecycle'
import { usePlacementStore } from '../placement/placementStore'
import { intersect, resolvePlacement, type Placement } from '../placement/resolvePlacement'
import { onPocketRequest, type PocketRequest } from '../state/pocketBus'
import { usePocketLive, usePocketLiveStore } from '../state/pocketLiveStore'
import { useRecoveryStore } from '../recovery/recoveryStore'
import { PocketLoadFailure } from './PocketLoadFailure'
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

  // A pocket that disappears (detach, session closed) is NOT unmounted at
  // once: it stays mounted, parked, as "retiring" until main has detached its
  // debugger. Destroying a <webview> with an attached debugger is a
  // main-process use-after-free (electron#53819), and an unmount cannot wait
  // for an IPC round trip (review B #1).
  //
  // Derived DURING render and rendered in the SAME keyed list as live pockets:
  // an effect would add it one render too late (the guest already unmounted),
  // and a separate list would give it a new component instance (React keys
  // are only unique within one array) — both destroyed the guest before
  // unregistering. The first version did exactly that; the host test caught it.
  const [, bump] = useState(0)
  const rendered = useRef<Record<string, HostedEntry>>({})
  const retired = useRef(new Set<string>())
  const forgetPlacement = usePlacementStore(s => s.forget)
  const forgetLive = usePocketLiveStore(s => s.forget)
  const live = Object.fromEntries(pockets.map(p => [p.pocket.pocketId, p]))
  const retiring: HostedEntry[] = []
  for (const [id, entry] of Object.entries(rendered.current)) {
    if (live[id]) { retired.current.delete(id); continue }
    // Turning the feature OFF retires every guest the same way. It used to
    // drop them at once on the assumption that main had already detached
    // every debugger, but the flags IPC is sent from a passive effect AFTER
    // this render, so the guests left the DOM with the debugger still
    // attached (review round 2, B #2).
    if (!retired.current.has(id)) retiring.push(entry)
  }
  rendered.current = { ...Object.fromEntries(retiring.map(e => [e.pocket.pocketId, e])), ...live }
  const onRetired = useCallback((pocketId: string) => {
    retired.current.add(pocketId)
    delete rendered.current[pocketId]
    forgetPlacement(pocketId)
    forgetLive(pocketId)
    bump(n => n + 1)
  }, [forgetPlacement, forgetLive])
  // Main announces every agent tool call (reads too) on this channel so a
  // hidden page is kept composited while an agent reads or screenshots it:
  // a non-composited guest's snapshot hangs or comes back empty (review B #5).
  useEffect(() => {
    if (!enabled) return
    const leases = new Map<string, () => void>()
    const off = window.api.onPocketPaint(({ pocketId, on }) => {
      if (on && !leases.has(pocketId)) leases.set(pocketId, usePlacementStore.getState().acquirePaint(pocketId))
      if (!on) { leases.get(pocketId)?.(); leases.delete(pocketId) }
    })
    return () => { off(); for (const release of leases.values()) release() }
  }, [enabled])

  useSleepPolicy(pockets.map(p => p.pocket.pocketId))

  return (
    <>
      {/* A <webview> swallows pointer events; during any split/lane drag the
          pointer crosses pages, so guests go inert (Orca's fix). */}
      <style>{'.pocket-dragging [data-pocket-guest]{pointer-events:none!important}'}</style>
      {[...pockets.map(p => ({ entry: p, retiring: false })), ...retiring.map(entry => ({ entry, retiring: true }))].map(({ entry, retiring: isRetiring }) => (
        <HostedPocket key={entry.pocket.pocketId} {...entry} workspace={workspace} onRetired={isRetiring ? onRetired : undefined} />
      ))}
    </>
  )
}

type HostedEntry = { sessionId: SessionId; pocket: BrowserPocketConfig; projectId: string | undefined }

/**
 * One pocket's guest, with an explicit lifecycle (review B #1–#3):
 *
 *   none ──create──▶ live(key) ──teardown──▶ none | live(newKey)
 *
 * `guestKey` IS the guest: a new key is a new <webview>. Every transition that
 * destroys a guest (sleep, crash remount, Retry/Reload, profile switch,
 * detach/close) goes through `teardown`, which awaits main unregistering it —
 * detaching the debugger — BEFORE the element leaves the DOM. Each new guest
 * starts at the pocket's CURRENT url, never the first one it ever had.
 */
const HostedPocket = memo(function HostedPocket({ sessionId, pocket, projectId, workspace, onRetired }: HostedEntry & {
  workspace: Workspace
  /** Set while retiring: tear the guest down, then report back. */
  onRetired?: (pocketId: string) => void
}) {
  const slots = usePlacementStore(s => s.slots[pocket.pocketId])
  const mustPaint = usePlacementStore(s => (s.paintLeases[pocket.pocketId] ?? 0) > 0)
  const lastSize = usePlacementStore(s => s.lastSize[pocket.pocketId] ?? null)
  const noteShown = usePlacementStore(s => s.noteShown)
  const live = usePocketLive(pocket.pocketId)
  const patchLive = usePocketLiveStore(s => s.patch)
  const { showToast } = useGlobalToast()
  const [partition, setPartition] = useState<string | null>(null)
  const [guestKey, setGuestKey] = useState<string | null>(null)
  const [element, setElement] = useState<WebviewElement | null>(null)
  const registered = useRef(false)
  const guestSeq = useRef(0)
  const src = useRef('about:blank')
  // Every guest transition runs on this chain, one after another. A guard
  // that simply RETURNED while a teardown was in flight made a second caller
  // (the session closing while a sleep teardown awaited main) believe the
  // guest was already gone, so the host dropped it before main had
  // unregistered it (review round 2, B #3).
  const transitions = useRef<Promise<void>>(Promise.resolve())
  const elementRef = useRef<WebviewElement | null>(null)
  // Read by page-event handlers attached once per guest. A ref, not a
  // dependency: after a reload the pocket's SessionId changes while the page
  // (and its listeners) must stay, and URL saves must follow the NEW id
  // (review B #2).
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId
  const pocketRef = useRef(pocket)
  pocketRef.current = pocket
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace
  const getWorkspace = useCallback(() => workspaceRef.current, [])

  // Receipt state survives guest remounts and lane/Spotlight changes, but not
  // a retired pocket or agent replacement. Clearing invalidates any async
  // wake/send token too; its late result cannot resurrect the removed UI.
  useEffect(() => () => useRecoveryStore.getState().clear(pocket.pocketId), [pocket.pocketId, sessionId])
  useEffect(() => { if (onRetired) useRecoveryStore.getState().clear(pocket.pocketId) }, [onRetired, pocket.pocketId])

  // Any agent tool call, the picker, or a painting lease needs a composited
  // page even when nothing shows it.
  const needsPaint = mustPaint || live.driving === 'agent' || live.picking || live.agentOpening
  const placement: Placement = onRetired
    ? { mode: 'parked', size: lastSize ?? { width: 1280, height: 800 }, mustPaint: false }
    : resolvePlacement({ slots: Object.values(slots ?? {}), alive: guestKey !== null && !live.asleep, mustPaint: needsPaint, lastSize })
  usePlacementTrace(pocket.pocketId, slots, placement)
  const wantsGuest = !onRetired && placement.mode !== 'absent' && !live.crashedOut && !live.asleep && (Boolean(pocket.url) || needsPaint)

  const teardown = useCallback((next: 'none' | 'remount', nextPartition?: string): Promise<void> => {
    const run = async () => {
      if (registered.current) {
        registered.current = false
        await window.api.unregisterPocketGuest({ pocketId: pocket.pocketId }).catch(() => {})
      }
      if (nextPartition) setPartition(nextPartition)
      if (next === 'remount') {
        src.current = startUrl(pocketRef.current.url)
        setGuestKey(`g${++guestSeq.current}`)
      } else {
        setGuestKey(null)
      }
    }
    const done = transitions.current.then(run, run)
    transitions.current = done.catch(() => {})
    return done
  }, [pocket.pocketId])

  // Create, sleep, wake.
  useEffect(() => {
    patchLive(pocket.pocketId, { hasGuest: guestKey !== null })
    if (onRetired) return
    if (live.asleep && placement.mode === 'shown') { patchLive(pocket.pocketId, { asleep: false }); return }
    if (wantsGuest && guestKey === null && partition) {
      src.current = startUrl(pocket.url)
      setGuestKey(`g${++guestSeq.current}`)
    } else if (live.asleep && guestKey !== null) {
      void teardown('none')
    }
  }, [wantsGuest, guestKey, partition, live.asleep, placement.mode, pocket.url, pocket.pocketId, onRetired, patchLive, teardown])

  // Retiring (detached or closed): unregister, then let the host drop us.
  useEffect(() => {
    if (!onRetired) return
    let done = false
    void teardown('none').then(() => { if (!done) onRetired(pocket.pocketId) })
    return () => { done = true }
  }, [onRetired, teardown, pocket.pocketId])

  // Remount requests (crash back-off, Retry, Reload) arrive as a generation bump.
  const generation = useRef(live.generation)
  useEffect(() => {
    if (live.generation === generation.current) return
    generation.current = live.generation
    if (guestKey !== null) void teardown('remount')
  }, [live.generation, guestKey, teardown])

  // The partition is fixed at attach time. Fetch it before the first guest;
  // a profile change needs a new guest in the new partition.
  const partitionKey = `${pocket.profile}:${projectId ?? ''}`
  const lastPartitionKey = useRef<string | null>(null)
  useEffect(() => {
    if (!wantsGuest && guestKey === null) return
    if (lastPartitionKey.current === partitionKey && partition) return
    let cancelled = false
    void window.api.pocketPartition({ pocketId: pocket.pocketId, profile: pocket.profile, ...(projectId ? { projectId } : {}) })
      .then(async name => {
        if (cancelled) return
        const changed = partition !== null && name !== partition
        lastPartitionKey.current = partitionKey
        if (changed && guestKey !== null) {
          // Unregister the old guest BEFORE the new partition remounts it,
          // on the same transition chain as every other teardown.
          await teardown('remount', name)
        } else {
          setPartition(name)
        }
      })
    return () => { cancelled = true }
  }, [wantsGuest, guestKey, partitionKey, partition, pocket.pocketId, pocket.profile, projectId, teardown])

  // Keep main's pocket → session mapping current across SessionId remaps.
  useEffect(() => {
    if (element && registered.current) void window.api.registerPocketGuest({ pocketId: pocket.pocketId, sessionId, webContentsId: element.getWebContentsId() })
  }, [sessionId, pocket.pocketId, element])

  // Colour scheme and zoom are page emulation, applied by main over CDP /
  // setZoomFactor; the device viewport is applied by sizing the element.
  useEffect(() => {
    if (!registered.current) return
    void window.api.applyPocketEmulation({ pocketId: pocket.pocketId, emulation: { colorScheme: pocket.colorScheme ?? null, zoom: pocket.zoom ?? 1 } })
  }, [pocket.pocketId, pocket.colorScheme, pocket.zoom])

  // Bus: commands, chrome row, main's page-local chords.
  useEffect(() => onPocketRequest((pocketId, request) => {
    if (pocketId !== pocket.pocketId) return
    handleRequest(request, element, pocketRef.current, sessionRef.current, workspace, patchLive, showToast)
  }), [pocket.pocketId, element, workspace, patchLive, showToast])

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

  // Page events, attached to EACH new guest element (a callback ref sets
  // `element`, so a remount re-runs this — the missing re-attach was review
  // B #1). Handlers read the session through sessionRef.
  elementRef.current = element
  useEffect(() => {
    const el = element
    if (!el) return
    const pocketId = pocket.pocketId
    const register = () => {
      const sent = sessionRef.current
      void window.api.registerPocketGuest({ pocketId, sessionId: sent, webContentsId: el.getWebContentsId() }).then(r => {
        // A reply for a guest that has since been replaced says nothing
        // about the current one.
        if (elementRef.current !== el) return
        registered.current = r.ok
        if (!r.ok) return
        patchLive(pocketId, { agentOpening: false })
        // The session was remapped while this registration was in flight.
        // The remap effect skipped it (not registered yet) and will not run
        // again, so main would keep the predecessor's id and the successor's
        // tools would find no pocket (review round 2, B #4).
        if (sessionRef.current !== sent) void window.api.registerPocketGuest({ pocketId, sessionId: sessionRef.current, webContentsId: el.getWebContentsId() })
        const p = pocketRef.current
        void window.api.applyPocketEmulation({ pocketId, emulation: { colorScheme: p.colorScheme ?? null, zoom: p.zoom ?? 1 } })
      })
    }
    const onNav = () => {
      if (elementRef.current !== el) return
      patchLive(pocketId, { canGoBack: el.canGoBack(), canGoForward: el.canGoForward() })
      const url = el.getURL()
      if (url && isAllowedTopLevelUrl(url)) workspace.updateBrowserPocket(s => setPocketUrl(s, sessionRef.current, url))
    }
    const onCommit = (e: Event) => {
      if (elementRef.current !== el) return
      const nav = e as unknown as { isMainFrame: boolean; httpResponseCode: number }
      // <webview>'s did-navigate carries ONLY url, unlike WebContents' event.
      // Response evidence belongs to did-frame-navigate. The error document
      // reports -1; neither it nor a successful iframe ends our failed episode.
      if (nav.isMainFrame && nav.httpResponseCode >= 100) {
        patchLive(pocketId, { failed: null })
        useRecoveryStore.getState().clear(pocketId)
      }
    }
    const onNavigationStart = (e: Event) => {
      if (elementRef.current !== el) return
      const nav = e as unknown as { isMainFrame: boolean; url: string }
      if (nav.isMainFrame) useRecoveryStore.getState().navigating(pocketId, nav.url)
    }
    const onStart = () => patchLive(pocketId, { loading: true })
    const onStop = () => patchLive(pocketId, { loading: false })
    const onTitle = (e: Event) => patchLive(pocketId, { title: (e as unknown as { title: string }).title })
    const onFail = (e: Event) => {
      if (elementRef.current !== el) return
      const f = e as unknown as { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean }
      // -3 is ERR_ABORTED: a navigation superseded by another, not a failure.
      if (f.isMainFrame && f.errorCode !== -3) {
        useRecoveryStore.getState().navigating(pocketId, f.validatedURL)
        patchLive(pocketId, { failed: { code: String(f.errorCode), description: f.errorDescription, url: f.validatedURL }, loading: false })
      }
    }
    const onConsole = (e: Event) => {
      const c = e as unknown as { level: number | string }
      if (c.level === 3 || c.level === 'error') patchLive(pocketId, prev => ({ unseenErrors: prev.unseenErrors + 1 }))
    }
    const onGone = () => {
      const now = Date.now()
      const crashes = [...usePocketLiveStore.getState().live[pocketId]?.crashes ?? [], now].filter(t => now - t < 30_000)
      const delay = nextCrashDelay(crashes.slice(0, -1), now)
      patchLive(pocketId, { crashes, loading: false })
      if (delay === null) { patchLive(pocketId, { crashedOut: true }); return }
      setTimeout(() => patchLive(pocketId, prev => ({ generation: prev.generation + 1 })), delay)
    }
    el.addEventListener('dom-ready', register, { once: true })
    el.addEventListener('did-navigate', onNav)
    el.addEventListener('did-frame-navigate', onCommit)
    el.addEventListener('did-start-navigation', onNavigationStart)
    el.addEventListener('did-navigate-in-page', onNav)
    el.addEventListener('did-start-loading', onStart)
    el.addEventListener('did-stop-loading', onStop)
    el.addEventListener('page-title-updated', onTitle)
    el.addEventListener('did-fail-load', onFail)
    el.addEventListener('console-message', onConsole)
    el.addEventListener('render-process-gone', onGone)
    return () => {
      el.removeEventListener('dom-ready', register)
      el.removeEventListener('did-navigate', onNav)
      el.removeEventListener('did-frame-navigate', onCommit)
      el.removeEventListener('did-start-navigation', onNavigationStart)
      el.removeEventListener('did-navigate-in-page', onNav)
      el.removeEventListener('did-start-loading', onStart)
      el.removeEventListener('did-stop-loading', onStop)
      el.removeEventListener('page-title-updated', onTitle)
      el.removeEventListener('did-fail-load', onFail)
      el.removeEventListener('console-message', onConsole)
      el.removeEventListener('render-process-gone', onGone)
    }
  }, [element, pocket.pocketId, patchLive, workspace])

  if (guestKey === null || !partition) return null

  const viewport = pocket.viewport && pocket.viewport.mode !== 'fill' ? viewportSize(pocket.viewport) : null
  const style = wrapperStyle(placement, viewport)
  const fit = placement.mode === 'shown' ? fitViewport(placement.rect, viewport) : null
  // The guest lives in this app-root layer, outside the lane whose
  // onMouseDownCapture moves lane focus, so clicking another lane's page left
  // commands (⌘⇧B, Spotlight) acting on the previous lane (review round 2,
  // B #5). A guest only takes DOM focus from a real click: agent input uses
  // CDP focus emulation and never focuses the element.
  const onFocus = () => {
    if (placement.mode !== 'shown') return
    const slot = slots?.[placement.slotKey]
    if (slot?.surface === 'lane' && !slot.focused && slot.laneIndex !== null) workspace.setTiledFocusedLane(slot.laneIndex)
  }
  return (
    <div data-pocket-guest style={style} aria-hidden={placement.mode !== 'shown'} onFocus={onFocus}>
      <webview
        key={guestKey}
        ref={setElementRef(setElement)}
        partition={partition}
        src={src.current}
        style={fit && viewport
          ? { position: 'absolute', left: fit.offsetX, top: fit.offsetY, width: fit.width, height: fit.height, transform: `scale(${fit.scale})`, transformOrigin: '0 0', display: 'flex' }
          : { width: '100%', height: '100%', display: 'flex' }}
      />
      {placement.mode === 'shown' && <GuestOverlays pocketId={pocket.pocketId} sessionId={sessionId} getWorkspace={getWorkspace} />}
    </div>
  )
})

/** The url a NEW guest starts at: the pocket's current one (review B #3). */
function startUrl(url: string | undefined): string {
  return url && isAllowedTopLevelUrl(url) ? url : 'about:blank'
}

const refCache = new WeakMap<object, (el: unknown) => void>()
/** A stable callback ref per setter, so React does not call it on every render. */
function setElementRef(set: (el: WebviewElement | null) => void): (el: unknown) => void {
  let ref = refCache.get(set)
  if (!ref) { ref = el => set(el as WebviewElement | null); refCache.set(set, ref) }
  return ref
}

/** Failure, crash and agent-cursor overlays drawn ABOVE the page. */
function GuestOverlays({ pocketId, sessionId, getWorkspace }: { pocketId: string; sessionId: SessionId; getWorkspace: () => Workspace }) {
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
      <PocketLoadFailure pocketId={pocketId} sessionId={sessionId} getWorkspace={getWorkspace} />
      {live.crashedOut && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-canvas p-6 text-center text-[12px] text-ink-dim">
          <div className="text-[13px] text-ink">This page crashed repeatedly</div>
          <Button type="button" variant="outline" size="sm" onClick={() => patchLive(pocketId, { crashedOut: false, crashes: [], generation: live.generation + 1 })}>Reload</Button>
        </div>
      )}
    </>
  )
}

export function wrapperStyle(placement: Placement, viewport: { width: number; height: number } | null): React.CSSProperties {
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
  // A hidden device viewport must keep its CSS dimensions too. Otherwise a
  // resize tool reports iPhone while the agent actually reads a desktop page.
  const size = viewport ?? (placement.mode === 'parked' ? placement.size : { width: 1280, height: 800 })
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
      if (pocket.url) void window.api.openRenderedExternalUrl({ url: pocket.url }).then(r => { if (!r.ok) showToast('Could not open that page in your browser.') })
      return
    case 'navigate':
      if (!isAllowedTopLevelUrl(request.url)) return
      useRecoveryStore.getState().navigating(pocket.pocketId, request.url)
      workspace.updateBrowserPocket(s => setPocketUrl(s, sessionId, request.url))
      patchLive(pocket.pocketId, { failed: null })
      // No guest yet (first URL of an empty pocket): the url write above makes
      // the host create one with this src.
      if (el) void el.loadURL(request.url).catch(() => {})
      return
    case 'pick':
      // ◎ / ⌘⇧S / the command while a pick is running CANCELS it; starting a
      // second pick ran two on one debugger and inserted two chips (review B #6).
      if (usePocketLiveStore.getState().live[pocket.pocketId]?.picking) {
        void window.api.cancelPocketPick({ pocketId: pocket.pocketId })
        return
      }
      void import('./pick').then(m => m.pickIntoComposer(pocket.pocketId, sessionId, workspace, patchLive, showToast))
      return
  }
  if (!el) return
  switch (request.type) {
    case 'reload': if (request.hard) el.reloadIgnoringCache(); else el.reload(); return
    case 'stop': el.stop(); return
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
      // Only pockets that HAVE a guest count toward the live cap: a restored
      // pocket never shown has no renderer process to save (review B #5).
      const input = pocketIds.filter(id => liveStore.live[id]?.hasGuest && !liveStore.live[id]?.asleep).map(id => ({
        pocketId: id,
        lastVisibleAt: placement.lastVisibleAt[id] ?? now,
        visible: Object.values(placement.slots[id] ?? {}).some(s => s.visible && (s.rect?.width ?? 0) > 0),
        agentLease: (placement.paintLeases[id] ?? 0) > 0 || (liveStore.live[id]?.driving != null && now - (liveStore.live[id]?.drivingAt ?? 0) < 30_000),
      }))
      for (const id of pocketsToSleep(input, now)) liveStore.patch(id, { asleep: true })
    }, 5_000)
    return () => clearInterval(timer)
  }, [pocketIds.join('|')])
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
