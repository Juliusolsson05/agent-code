import { useEffect, useRef, useState } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import type { AgentCodeApiV1 } from '@renderer/apps/api/types'
import { createFrameHost } from '@renderer/apps/host/frameHost'
import { clearFrameDispatch, setFrameDispatch } from '@renderer/apps/host/frameRegistry'
import { THEME_CHANGED_EVENT } from '@renderer/app-state/settings/theme'
import type { ExtensionListEntry } from '@shared/types/extensions'

// How long the host waits for the frame's own boot signal before calling the load
// failed. Generous: the only thing it races is a frame that will never start, and a
// premature "failed" on a slow machine is a worse lie than a late one.
const BOOT_TIMEOUT_MS = 10_000

/**
 * Record (or clear) an extension's failure on its Settings row.
 *
 * WHY these write through the store rather than local component state: the failure
 * belongs to the EXTENSION, not to this view instance. Settings lists it next to the
 * extension long after the frame that produced it was closed, and a second frame for
 * the same extension must not show a stale failure from the first.
 */
function reportFailure(extensionId: string, message: string): void {
  const state = useAppStore.getState()
  const name =
    state.installedExtensions.find(candidate => candidate.manifest.id === extensionId)?.manifest
      .name ?? extensionId
  state.setExtensionFailures([
    ...state.extensionFailures.filter(failure => failure.id !== extensionId),
    { id: extensionId, name, error: message },
  ])
}

function clearFailure(extensionId: string): void {
  const state = useAppStore.getState()
  if (!state.extensionFailures.some(failure => failure.id === extensionId)) return
  state.setExtensionFailures(state.extensionFailures.filter(failure => failure.id !== extensionId))
}

/**
 * Adapts a contributed view into the `AppDefinition.Component` shape — the iframe
 * model (WS4, Decision A).
 *
 * This is the ENTIRE bridge between the host's React world and the extension. It
 * was the same-realm `mount(element)` call the DOM-level ViewMount contract was
 * designed around; that contract is exactly what let this become an iframe without
 * touching the extension: the extension still exports `activate(context)` and calls
 * `registerView(id, mount)`, but now that runs in the CHILD document (see
 * frameDocument.ts's bootstrap), and the parent only frames it, brokers its Tier-0
 * API over postMessage (frameHost.ts), and signals which view to mount.
 *
 * WHY the parent never imports or activates the extension: an iframe at the
 * extension's own origin cannot reach `window.api`, the parent DOM, or another
 * extension, so the module MUST run on the far side of that boundary. Commands run
 * there too — the frame is the ONE place an extension executes, which is what ended
 * the split-brain where a palette command drove a different instance than the
 * visible view.
 *
 * RUNTIME NOTE: this is the WS4 flip that can only be validated in a live frame —
 * the iframe load, the postMessage handshake, and the child CSP are not
 * typecheckable. A real extension view rendering is its acceptance test.
 */
function buildViewComponent(
  extensionId: string,
  viewId: string,
  // The installed bundle's identity. Not read for behaviour — it is part of the
  // CACHE KEY and of the frame URL, which is what makes an update replace the
  // running frame. See viewComponentFor.
  bundleRevision: string,
  // When true (a PANE host), the iframe FILLS its container rather than sizing to
  // the extension's reported content height. A modal floats and should hug its view
  // (content-height); a pane is a fixed tile and the view should fill it edge to
  // edge. The child still reports its size — we simply ignore it for height in fill
  // mode. Defaults false so the modal path is unchanged.
  fill = false,
): (props: { api: AgentCodeApiV1 }) => JSX.Element {
  return function ExtensionView({ api }: { api: AgentCodeApiV1 }) {
    // Read the display name from the store rather than closing over a manifest.
    // The component is cached by identity (see viewComponentFor), so a captured
    // manifest would go stale the first time the extension was updated — and the
    // name is the only manifest field this component ever needed.
    const displayName = useAppStore(
      state =>
        state.installedExtensions.find(candidate => candidate.manifest.id === extensionId)
          ?.manifest.name ?? extensionId,
    )
    const iframeRef = useRef<HTMLIFrameElement | null>(null)
    const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
    // Content-driven height. The child (frameDocument.ts) measures its own view and
    // posts its natural height; we size the iframe to it so the auto-height host
    // modal grows to fit the extension instead of clamping it. Null until the first
    // report — the iframe falls back to a minimum so it is never a zero-height strip.
    const [contentHeight, setContentHeight] = useState<number | null>(null)
    // Content-driven WIDTH, the sibling of the height above: a fixed-width extension
    // (a game canvas) reports its natural width and the modal grows to fit it, while
    // a small extension stays snug. Null until the first report → the iframe falls
    // back to filling its container (the modal's own width).
    const [contentWidth, setContentWidth] = useState<number | null>(null)

    // Viewport, tracked so an oversized extension can be SCALED to fit (see `scale`).
    const [viewport, setViewport] = useState(() => ({
      w: typeof window === 'undefined' ? 1280 : window.innerWidth,
      h: typeof window === 'undefined' ? 800 : window.innerHeight,
    }))
    useEffect(() => {
      if (fill) return
      const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight })
      window.addEventListener('resize', onResize)
      return () => window.removeEventListener('resize', onResize)
    }, [])

    useEffect(() => {
      const iframe = iframeRef.current
      if (!iframe) {
        setStatus('failed')
        return
      }

      // The broker: the ONLY thing that can both hear this frame and perform a
      // capability. Attached before the src is set so no early message is missed.
      const frameHost = createFrameHost({ iframe, extensionId, api })

      // This frame's command dispatcher, published to the registry once the child
      // signals ready. derive.ts looks it up to route a contributed command's
      // invocation into THIS frame — the one place the extension actually runs.
      const dispatch = (commandId: string) =>
        frameHost.push({ kind: 'agent-code-ext:command', commandId })

      // Presentational + lifecycle side-channels, kept OUT of frameHost: neither a
      // resize nor a ready signal is a capability request (they perform nothing,
      // carry no authority), so they do not belong in the schema-validated request
      // path. Authenticated the same way frameHost authenticates requests — by
      // window reference, which no other frame can forge.
      const expectedChildOrigin = `agent-code-ext://${extensionId}`
      const onChildMessage = (event: MessageEvent) => {
        // TWO gates, matching frameHost — source AND origin. This listener previously
        // checked only the window reference, and claimed parity with frameHost while
        // having one fewer check. `iframe.contentWindow` is an identity-stable
        // WindowProxy across navigations, so source alone survives a frame navigating
        // itself: a document at any other agent-code-ext:// origin landing in this frame
        // could still fire `ready` and publish a command dispatcher under THIS
        // extension's id. Origin is the gate that actually distinguishes them.
        if (event.source !== iframe.contentWindow) return
        if (event.origin !== expectedChildOrigin) return
        const data = event.data as
          | { kind?: unknown; height?: unknown; width?: unknown; message?: unknown }
          | null
        if (!data) return
        if (data.kind === 'agent-code-ext:resize') {
          // Clamped so a buggy or hostile child cannot drive the modal past the
          // viewport or collapse it to nothing.
          if (typeof data.height !== 'number' || !Number.isFinite(data.height)) return
          setContentHeight(Math.min(Math.max(Math.round(data.height), 80), 1400))
          if (typeof data.width === 'number' && Number.isFinite(data.width)) {
            setContentWidth(Math.min(Math.max(Math.round(data.width), 240), 1200))
          }
        } else if (data.kind === 'agent-code-ext:boot') {
          // The frame document is executing. This — not the iframe's own 'load'
          // event — is what proves the load succeeded: an iframe fires 'load' for
          // an HTTP error body exactly as it does for a real page, and never fires
          // 'error' for one, so onError below can only ever catch a network-layer
          // failure. Without this signal a 404 from the scheme handler showed as a
          // blank frame stuck in 'ready' forever.
          if (bootTimer !== null) {
            clearTimeout(bootTimer)
            bootTimer = null
          }
          setStatus('ready')
          clearFailure(extensionId)
        } else if (data.kind === 'agent-code-ext:escape') {
          // The frame saw an unhandled Escape. Close the view, which is what Escape
          // does everywhere else in the app — a modal's own Escape handler and a
          // pane's Cmd+W both end at this same call. Routed through `api.ui.close`
          // rather than a local close so the modal and pane hosts keep their single
          // shared definition of what closing means.
          void api.ui.close()
        } else if (data.kind === 'agent-code-ext:error') {
          // activate() or the dynamic import threw inside the frame. The frame is
          // the only place that can observe it — the extension does not run in this
          // realm — so it reports here and we surface it on the Settings row.
          setStatus('failed')
          reportFailure(
            extensionId,
            typeof data.message === 'string' ? data.message : 'Extension failed to start.',
          )
        } else if (data.kind === 'agent-code-ext:ready') {
          // activate() has RESOLVED — command handlers now exist, so it is safe to
          // publish the dispatcher and flush any queued commands. Distinct from
          // 'boot', which only says the document started.
          setFrameDispatch(extensionId, dispatch)
        }
      }
      window.addEventListener('message', onChildMessage)

      // Backstop for every failure that produces no message at all: a 404/403 body,
      // a CSP violation that blocks the bootstrap, a syntax error in it. Generous
      // on purpose — this races nothing but a broken frame, and a false "failed"
      // on a slow machine would be worse than a late one.
      let bootTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        bootTimer = null
        setStatus(current => (current === 'loading' ? 'failed' : current))
        reportFailure(
          extensionId,
          'The extension frame did not start. Its bundle may be missing or blocked.',
        )
      }, BOOT_TIMEOUT_MS)

      // Live observe: nudge the frame when the workspace changes, for each observe
      // topic the extension was granted, so its api.*.subscribe listeners re-read.
      // The nudge carries no data — the child re-reads via the grant-gated observe()
      // — so this cannot leak state to an ungranted extension; gating the SUBSCRIPTION
      // here is only to avoid waking a frame that could not read anyway. Coalesced so
      // a burst of store writes becomes one nudge, not one per write.
      let storeUnsub: (() => void) | null = null
      let observeDisposed = false
      let nudgeTimer: ReturnType<typeof setTimeout> | null = null
      // Reuses the broker's already-resolved grant instead of issuing a second IPC.
      // Each call recomputes the bundle hash in main, so the duplicate doubled that
      // work on every single frame open.
      void frameHost.granted.then(granted => {
        if (observeDisposed) return
        const topics = (
          [
            ['workspace.observe', 'workspace'],
            ['sessions.observe', 'sessions'],
            ['panes.observe', 'panes'],
          ] as const
        )
          .filter(([cap]) => granted.includes(cap))
          .map(([, topic]) => topic)
        if (topics.length === 0) return
        storeUnsub = useAppStore.subscribe(
          state => state.workspaceState,
          () => {
            if (nudgeTimer) return
            nudgeTimer = setTimeout(() => {
              nudgeTimer = null
              for (const topic of topics) frameHost.push({ kind: 'agent-code-ext:event', topic })
            }, 120)
          },
        )
      })

      const pushTheme = () => {
        // The CSS cascade does not cross the frame boundary, so tokens are pushed.
        void api.theme.tokens().then(tokens =>
          frameHost.push({ kind: 'agent-code-ext:theme', tokens }),
        )
      }

      const onLoad = () => {
        // Deliberately does NOT set 'ready' — see the boot handler above. This
        // fires for an error body too, so treating it as success is what made the
        // failure state unreachable.
        //
        // THEME BEFORE MOUNT — the ordering is load-bearing.
        //
        // Previously mount was pushed synchronously and the theme followed a microtask
        // later (tokens() is async), so the view rendered against variables that did not
        // exist yet and every extension had to carry its own fallback palette to avoid a
        // flash of unstyled content. That is why extensions ended up re-declaring the
        // whole token set locally — the platform gave them no moment at which the theme
        // was guaranteed present.
        //
        // Pushing theme first, then mount, closes that window: postMessage preserves
        // order, so by the time the child mounts, --theme-* is already set on its
        // documentElement. Extensions can now write var(--theme-canvas) bare.
        //
        // A theme failure must never prevent the view from mounting, hence the catch:
        // an unthemed extension is a bug, an unmounted one is a broken product.
        void api.theme
          .tokens()
          .then(tokens => frameHost.push({ kind: 'agent-code-ext:theme', tokens }))
          .catch(() => {})
          .finally(() => frameHost.push({ kind: 'agent-code-ext:mount', viewId }))
      }
      // A frame that cannot even load its document (bad scheme response, blocked
      // by CSP) fails visibly rather than showing an indefinite spinner.
      const onError = () => setStatus('failed')

      iframe.addEventListener('load', onLoad)
      iframe.addEventListener('error', onError)
      window.addEventListener(THEME_CHANGED_EVENT, pushTheme)

      // parentOrigin is passed so the child posts its replies back to THIS origin
      // only, never '*'. location.origin is http://localhost in dev and file://
      // in prod; the child cannot know it otherwise across the boundary.
      // `rev` is not read by the frame document — it exists so the URL CHANGES when
      // the installed bundle changes. Without it, an update left every open pane
      // executing the pre-update code indefinitely: the effect is mount-once, the
      // component is cached by identity, and the URL was constant, so nothing about
      // a reinstall reached a live frame. Worse, install re-binds the grant to the
      // new bytes, so the stale frame would start failing capability calls it had
      // been holding.
      iframe.src =
        `agent-code-ext://${extensionId}/__agent-code-frame__.html` +
        `?view=${encodeURIComponent(viewId)}` +
        `&rev=${encodeURIComponent(bundleRevision)}`

      return () => {
        iframe.removeEventListener('load', onLoad)
        iframe.removeEventListener('error', onError)
        window.removeEventListener('message', onChildMessage)
        window.removeEventListener(THEME_CHANGED_EVENT, pushTheme)
        observeDisposed = true
        if (bootTimer !== null) clearTimeout(bootTimer)
        if (nudgeTimer) clearTimeout(nudgeTimer)
        storeUnsub?.()
        clearFrameDispatch(extensionId, dispatch)
        frameHost.dispose()
        // Navigate the frame away so any timers/listeners inside it are torn down
        // by the browser — the frame model's equivalent of disposing the mount.
        iframe.src = 'about:blank'
      }
      // Mount-once: entry and viewId are fixed for this component's lifetime.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // ── FIT AN OVERSIZED EXTENSION TO THE WINDOW ──
    //
    // An extension with a FIXED natural size — a game canvas is the motivating case —
    // reports e.g. 892×652. That fits a normal window, but on a short one the modal
    // previously CLIPPED it: DialogContent has no maxHeight and is `overflow-hidden`,
    // so the bottom of the game simply vanished with no scrollbar and no way to reach
    // the action buttons.
    //
    // Scaling rather than scrolling, because the content is a single fixed-aspect
    // surface: a scrollbar on a game is worse than a slightly smaller game, and
    // clipping is worse than both.
    //
    // This MUST live host-side. The obvious alternative — have the extension size
    // itself in vw/vh — is a trap: those units resolve against the IFRAME's viewport,
    // which the host sets from the content's reported size, so the extension's size
    // would depend on its own size. That is exactly the resize feedback loop
    // frameDocument.ts's measurement is carefully built to avoid.
    //
    // Budgets leave room for the modal's own chrome and the scrim margin.
    const scale =
      fill || !contentWidth || !contentHeight
        ? 1
        : Math.min(1, (viewport.w * 0.9) / contentWidth, (viewport.h * 0.86) / contentHeight)

    // The wrapper must occupy the SCALED footprint, otherwise the auto-sized modal
    // reserves room for the unscaled iframe and the game floats in dead space.
    const scaledBox =
      !fill && status === 'ready' && contentWidth && contentHeight
        ? { width: contentWidth * scale, height: contentHeight * scale }
        : undefined

    return (
      <div
        className={fill ? 'relative h-full w-full' : 'relative min-h-[120px]'}
        style={scaledBox}
      >
        {status === 'loading' ? (
          <div className="px-6 py-8 text-[12px] text-muted">Loading {displayName}…</div>
        ) : null}
        {status === 'failed' ? (
          <div className="px-6 py-8">
            <div className="text-[13px] text-ink">{displayName} failed to start</div>
            <div className="mt-1 text-[12px] text-muted">
              The extension frame could not be loaded.
            </div>
          </div>
        ) : null}
        {/* Always present so the ref exists before the effect runs.
            ── THE SANDBOX ATTRIBUTE IS LOAD-BEARING ──
            An earlier comment here claimed `sandbox` could not be used because it would
            give the frame an opaque "null" origin and break the origin-derived identity
            the broker depends on. That is only true WITHOUT `allow-same-origin`.
            With it, the document keeps its agent-code-ext://<id> origin — so event.origin
            and every identity check are untouched — while the other flags stay off.

            What staying off buys, none of which CSP can do:
              - no allow-popups        → window.open() is dead. This was a real egress
                                         channel: no CSP directive governs window.open
                                         (navigate-to was never shipped), so a Tier-0
                                         extension could exfiltrate storage to any URL
                                         via the OS browser with no consent prompt.
              - no allow-top-navigation → cannot navigate the whole app away.
              - no allow-modals         → cannot wedge the renderer with alert()/print().
              - no allow-forms          → closes the <form target=_blank> egress variant.
              - no allow-downloads      → closes download-based exfiltration.

            The usual objection — that a frame with both allow-scripts and
            allow-same-origin can strip its own sandbox — requires the child to be
            same-origin with the EMBEDDER. Here it is cross-origin to the host, so it
            cannot reach the <iframe> element at all.

            Enforcing here rather than in setWindowOpenHandler is deliberate: Electron's
            HandlerDetails carries no `frame` field, and `referrer` is suppressible with
            window.open(url, '_blank', 'noreferrer'), so main cannot reliably identify
            the initiating frame. The attribute is the only place this is decidable. */}
        <iframe
          ref={iframeRef}
          sandbox="allow-scripts allow-same-origin"
          title={displayName}
          style={{
            display: status === 'ready' ? 'block' : 'none',
            border: 'none',
            // Pane (fill): fill the tile in both axes. Modal: a definite pixel width
            // once reported (so a content-width modal wraps it), else 100% of the
            // modal's own width until the first report.
            width: fill ? '100%' : contentWidth ?? '100%',
            // Modal: a definite pixel height once the child reports its content size —
            // that is what lets the auto-size modal grow to fit. Before the first
            // report we use the floor, never '100%': '100%' of an auto parent is what
            // collapsed the frame to a strip.
            height: fill ? '100%' : contentHeight ?? 120,
            minHeight: fill ? undefined : 120,
            // The iframe keeps its NATURAL pixel size and is scaled visually, so the
            // extension's own layout never changes and it never learns it was resized
            // (which would re-trigger the content-size report). Origin top-left so the
            // scaled box lines up with the wrapper computed above.
            transform: scale === 1 ? undefined : `scale(${scale})`,
            transformOrigin: 'top left',
          }}
        />
      </div>
    )
  }
}

// ── COMPONENT IDENTITY IS CACHED, AND THAT IS A CORRECTNESS REQUIREMENT ──
//
// React remounts on component IDENTITY, not on props. `deriveAppDefinitions` and
// `ExtensionViewLeaf` both call this while deriving from the installed list, and
// that list is refetched on every install, update and remove — so minting a fresh
// closure per call meant that installing ANY extension unmounted every open
// extension view, destroyed its iframe, and re-ran activate() in a new document.
// A running timer reset because an unrelated extension was installed.
//
// Keying on the identity triple is what makes the derivation idempotent. Nothing
// else varies the component: `fill` picks the layout, and the manifest name is
// read from the store inside the component precisely so it need not be a key.
//
// The map is bounded by (installed extensions x contributed views x 2), which is
// the same order as the ledger itself, and entries stay valid across an uninstall
// + reinstall of the same id — the component holds no manifest, only ids.
const componentCache = new Map<string, (props: { api: AgentCodeApiV1 }) => JSX.Element>()

/**
 * What makes one installed version of a view distinct from another.
 *
 * `sha256` alone would be ideal, but it is provenance and can legitimately repeat
 * (reinstalling the same tarball); `version` alone is author-controlled and often
 * unchanged during development. Together they change whenever the installed bytes
 * or the declared version do, which is exactly when a running frame is stale.
 */
function bundleRevisionOf(entry: ExtensionListEntry): string {
  return `${entry.manifest.version}-${entry.sha256.slice(0, 12)}`
}

/**
 * The host-side component for one contributed view: a sandboxed iframe at the
 * extension's origin plus the postMessage broker for it.
 *
 * `fill` true means a PANE host — the iframe fills its tile instead of sizing to
 * the extension's reported content height, which is what a floating modal does.
 */
export function viewComponentFor(
  entry: ExtensionListEntry,
  viewId: string,
  fill = false,
): (props: { api: AgentCodeApiV1 }) => JSX.Element {
  const revision = bundleRevisionOf(entry)
  // The revision is part of the key, so an UPDATE yields a different component
  // identity and React remounts the frame against the new bundle — while a mere
  // list refresh (install of some other extension, a failed-then-retried list)
  // yields the same key and leaves running views untouched. Those two cases were
  // previously indistinguishable: keying on identity alone made every refresh
  // harmless but also made updates invisible.
  const key = `${entry.manifest.id}\u0000${viewId}\u0000${fill}\u0000${revision}`
  const cached = componentCache.get(key)
  if (cached) return cached
  const built = buildViewComponent(entry.manifest.id, viewId, revision, fill)
  componentCache.set(key, built)
  return built
}
