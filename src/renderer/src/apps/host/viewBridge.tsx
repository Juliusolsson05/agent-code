import { useEffect, useRef, useState } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import type { AgentCodeApiV1 } from '@renderer/apps/api/types'
import { createFrameHost } from '@renderer/apps/host/frameHost'
import { clearFrameDispatch, discardPendingCommands, setFrameDispatch } from '@renderer/apps/host/frameRegistry'
import { THEME_CHANGED_EVENT } from '@renderer/app-state/settings/theme'
import type { ExtensionListEntry } from '@shared/types/extensions'
import { extensionRevision } from '@shared/types/extensions'
import { bindExtensionFrameInput } from './nativeInput'

type ExtensionViewProps = { api: AgentCodeApiV1; onFocus?: () => void; focused?: boolean }

// A document can boot while activate() hangs forever. Keep one deadline through
// import, activation, theme delivery and mount; only the final ready signal ends
// it. Boot alone proves the scheme document ran, not that there is a usable view.
const STARTUP_TIMEOUT_MS = 10_000

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
 * Mount a contributed view in its own sandboxed document. The v1 compatibility
 * path activates the legacy closure-based module in each view. A v2 document
 * imports only its view entry and attaches to the main-owned engine; closing or
 * retrying that document must never create a second copy of extension-wide state.
 *
 * Both paths share theme, sizing, failure and teardown behavior. Keeping those
 * lifecycle gates in one bridge prevents v2 from reintroducing the startup races
 * already covered by the real Electron frame tests.
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
  managed = false,
): (props: ExtensionViewProps) => JSX.Element {
  return function ExtensionView({ api, onFocus, focused }: ExtensionViewProps) {
    const focusCallback = useRef(onFocus)
    focusCallback.current = onFocus
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
    const [failureMessage, setFailureMessage] = useState('')
    const [attempt, setAttempt] = useState(0)
    const statusRef = useRef(status)
    statusRef.current = status
    useEffect(() => {
      if (!managed) return
      // ⌘Q stops every runtime before window unload vetoes run, which closes each
      // attached v2 view and lands it in fail() as "Agent Code is closing". When
      // the unsaved-changes sheet cancels the quit, main resumes the host and
      // announces it. Retry exactly the views that failed meanwhile, instead of
      // leaving every open extension on "failed to start" until a manual Retry;
      // a genuinely broken view simply fails once more.
      return window.api.onExtensionsRuntimeResumed(() => {
        if (statusRef.current === 'failed') setAttempt(current => current + 1)
      })
    }, [])
    useEffect(() => {
      // Keyboard navigation into an extension must move DOM focus too. Do not
      // refocus an already active iframe: that would reset its author's input.
      const iframe = iframeRef.current
      if (focused && status === 'ready' && iframe && document.activeElement !== iframe) iframe.focus()
    }, [focused, status])
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
      if (!iframe) return
      setStatus('loading')
      setFailureMessage('')
      setContentHeight(null)
      setContentWidth(null)

      // Every retry owns a fresh browser document, broker and deadline. A late
      // theme/grant promise from the previous attempt must neither revive the
      // failed frame nor register subscriptions on behalf of the replacement.
      let disposed = false
      let booted = false
      let ready = false
      let themeRequest = 0
      let startupTimer: ReturnType<typeof setTimeout> | null = null
      let nudgeTimer: ReturnType<typeof setTimeout> | null = null
      let storeUnsub: (() => void) | null = null
      const stopInput = bindExtensionFrameInput(iframe, () => focusCallback.current?.())
      const closeFromHost = () => { void api.ui.close() }
      iframe.addEventListener('agent-code-extension-close', closeFromHost)
      const frameHost = createFrameHost({ iframe, extensionId, bundleRevision, api, ...(managed ? { runtime: { viewId, onFailure: (message: string) => fail(message) } } : {}) })
      const dispatch = (commandId: string) =>
        frameHost.push({ kind: 'agent-code-ext:command', commandId })

      const stop = () => {
        if (disposed) return
        disposed = true
        if (startupTimer !== null) clearTimeout(startupTimer)
        if (nudgeTimer !== null) clearTimeout(nudgeTimer)
        storeUnsub?.()
        stopInput()
        iframe.removeEventListener('agent-code-extension-close', closeFromHost)
        clearFrameDispatch(extensionId, dispatch)
        frameHost.dispose()
        // Failure is also teardown, not just an overlay. Otherwise a timed-out
        // activate() could finish later and keep storage access behind the error
        // screen. Navigation destroys that document's timers and listeners.
        iframe.src = 'about:blank'
      }
      const fail = (message: string) => {
        if (disposed) return
        setStatus('failed')
        setFailureMessage(message)
        reportFailure(extensionId, message)
        // A command queued for this start must not survive it: otherwise it fires
        // on a later, unrelated open after Retry or Reload succeeds.
        discardPendingCommands(extensionId)
        stop()
      }

      const pushTheme = () => {
        if (disposed) return
        const request = ++themeRequest
        void api.theme.tokens().then(tokens => {
          if (disposed || request !== themeRequest) return
          frameHost.push({ kind: 'agent-code-ext:theme', tokens })
          if (!ready) frameHost.push({ kind: 'agent-code-ext:mount', viewId })
        }).catch(error => {
          if (disposed || request !== themeRequest) return
          fail(`Could not apply the extension theme: ${error instanceof Error ? error.message : String(error)}`)
        })
      }

      const expectedChildOrigin = `agent-code-ext://${extensionId}`
      const onChildMessage = (event: MessageEvent) => {
        // The WindowProxy survives navigation. Check both source AND origin so
        // a document reached by navigating this frame cannot claim its identity.
        if (disposed || event.source !== iframe.contentWindow || event.origin !== expectedChildOrigin) return
        const data = event.data as
          | { kind?: unknown; height?: unknown; width?: unknown; message?: unknown }
          | null
        if (!data) return
        if (data.kind === 'agent-code-ext:resize') {
          if (typeof data.height !== 'number' || !Number.isFinite(data.height)) return
          setContentHeight(Math.min(Math.max(Math.round(data.height), 80), 1400))
          if (typeof data.width === 'number' && Number.isFinite(data.width)) {
            setContentWidth(Math.min(Math.max(Math.round(data.width), 240), 1200))
          }
        } else if (data.kind === 'agent-code-ext:boot') {
          // iframe.load also fires for a 404 body. The bootstrap announcement is
          // the only evidence that this document can receive our handshake. It
          // does NOT clear the startup deadline: import/activate can still hang.
          if (booted) return
          booted = true
          pushTheme()
        } else if (data.kind === 'agent-code-ext:escape') {
          void api.ui.close()
        } else if (data.kind === 'agent-code-ext:error') {
          fail(typeof data.message === 'string' ? data.message : 'Extension failed to start.')
        } else if (data.kind === 'agent-code-ext:ready') {
          if (!booted || ready) return
          ready = true
          if (startupTimer !== null) clearTimeout(startupTimer)
          startupTimer = null
          setStatus('ready')
          if (!managed) setFrameDispatch(extensionId, dispatch)
          // Only a completed startup can clear a failure from an earlier frame.
          clearFailure(extensionId)
        }
      }
      window.addEventListener('message', onChildMessage)
      startupTimer = setTimeout(() => {
        startupTimer = null
        fail(booted
          ? 'The extension did not finish starting within 10 seconds. Its activation or view mount may be stuck.'
          : 'The extension frame did not start. Its bundle may be missing or blocked.')
      }, STARTUP_TIMEOUT_MS)

      // Nudges carry no workspace data: re-reading is still grant-gated in the
      // broker. Share its initial hash/grant check and coalesce store updates so
      // a burst of workspace changes does not flood the child message queue.
      void frameHost.granted.then(granted => {
        if (disposed) return
        const topics = ([
          ['workspace.observe', 'workspace'],
          ['sessions.observe', 'sessions'],
          ['panes.observe', 'panes'],
        ] as const).filter(([cap]) => granted.includes(cap)).map(([, topic]) => topic)
        if (topics.length === 0) return
        storeUnsub = useAppStore.subscribe(
          state => state.workspaceState,
          () => {
            if (nudgeTimer !== null) return
            nudgeTimer = setTimeout(() => {
              nudgeTimer = null
              if (disposed) return
              for (const topic of topics) frameHost.push({ kind: 'agent-code-ext:event', topic })
            }, 120)
          },
        )
      })

      const onError = () => fail('The extension frame could not be loaded.')
      iframe.addEventListener('error', onError)
      window.addEventListener(THEME_CHANGED_EVENT, pushTheme)
      iframe.src =
        `agent-code-ext://${extensionId}/__bundle/${encodeURIComponent(bundleRevision)}/__agent-code-frame__.html` +
        `?view=${encodeURIComponent(viewId)}` +
        `&rev=${encodeURIComponent(bundleRevision)}&instance=${crypto.randomUUID()}&shell=${fill ? 'panel' : 'modal'}`

      return () => {
        iframe.removeEventListener('error', onError)
        window.removeEventListener('message', onChildMessage)
        window.removeEventListener(THEME_CHANGED_EVENT, pushTheme)
        stop()
      }
      // Identity and API ownership are fixed for this component. Only an explicit
      // retry replaces its document; ordinary store renders must leave it running.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [attempt])

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
          <div role="alert" className="break-words px-6 py-8">
            <div className="text-[13px] text-ink">{displayName} failed to start</div>
            <div className="mt-1 text-[12px] text-muted">
              {failureMessage}
            </div>
            <button type="button" aria-label={`Retry ${displayName}`} className="mt-3 rounded border border-border px-3 py-1 text-[12px] text-ink" onClick={() => setAttempt(current => current + 1)}>
              Retry
            </button>
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
          data-extension-shell={fill ? 'panel' : 'modal'}
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
const componentCache = new Map<string, (props: ExtensionViewProps) => JSX.Element>()

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
  managed = false,
): (props: ExtensionViewProps) => JSX.Element {
  const revision = extensionRevision(entry)
  // The revision is part of the key, so an UPDATE yields a different component
  // identity and React remounts the frame against the new bundle — while a mere
  // list refresh (install of some other extension, a failed-then-retried list)
  // yields the same key and leaves running views untouched. Those two cases were
  // previously indistinguishable: keying on identity alone made every refresh
  // harmless but also made updates invisible.
  const key = `${entry.manifest.id}\u0000${viewId}\u0000${fill}\u0000${revision}`
  const cached = componentCache.get(key)
  if (cached) return cached
  const built = buildViewComponent(entry.manifest.id, viewId, revision, fill, entry.manifest.apiVersion === 2)
  componentCache.set(key, built)
  return built
}
