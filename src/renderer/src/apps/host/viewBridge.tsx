import { useEffect, useRef, useState } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import type { AgentCodeApiV1 } from '@renderer/apps/api/types'
import type { ExtensionHost } from '@renderer/apps/host/ExtensionHost'
import { createFrameHost } from '@renderer/apps/host/frameHost'
import { clearFrameDispatch, setFrameDispatch } from '@renderer/apps/host/frameRegistry'
import { THEME_CHANGED_EVENT } from '@renderer/app-state/settings/theme'
import type { ExtensionListEntry } from '@shared/types/extensions'

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
 * WHY the parent no longer imports or activates the extension: an iframe at the
 * extension's own origin cannot reach `window.api`, the parent DOM, or another
 * extension, so the module MUST run on the far side of that boundary. The
 * host-side ExtensionHost still owns command activation (same realm), which is why
 * `host` remains in the signature even though this view path no longer calls it.
 *
 * RUNTIME NOTE: this is the WS4 flip that can only be validated in a live frame —
 * the iframe load, the postMessage handshake, and the child CSP are not
 * typecheckable. A real extension view rendering is its acceptance test.
 */
export function viewComponentFor(
  _host: ExtensionHost,
  entry: ExtensionListEntry,
  viewId: string,
  // When true (a PANE host), the iframe FILLS its container rather than sizing to
  // the extension's reported content height. A modal floats and should hug its view
  // (content-height); a pane is a fixed tile and the view should fill it edge to
  // edge. The child still reports its size — we simply ignore it for height in fill
  // mode. Defaults false so the modal path is unchanged.
  fill = false,
): (props: { api: AgentCodeApiV1 }) => JSX.Element {
  const extensionId = entry.manifest.id
  return function ExtensionView({ api }: { api: AgentCodeApiV1 }) {
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
      const onChildMessage = (event: MessageEvent) => {
        if (event.source !== iframe.contentWindow) return
        const data = event.data as { kind?: unknown; height?: unknown; width?: unknown } | null
        if (!data) return
        if (data.kind === 'agent-code-ext:resize') {
          // Clamped so a buggy or hostile child cannot drive the modal past the
          // viewport or collapse it to nothing.
          if (typeof data.height !== 'number' || !Number.isFinite(data.height)) return
          setContentHeight(Math.min(Math.max(Math.round(data.height), 80), 1400))
          if (typeof data.width === 'number' && Number.isFinite(data.width)) {
            setContentWidth(Math.min(Math.max(Math.round(data.width), 240), 1200))
          }
        } else if (data.kind === 'agent-code-ext:ready') {
          // activate() has resolved in the frame — command handlers now exist, so
          // it is safe to publish the dispatcher and flush any queued commands.
          setFrameDispatch(extensionId, dispatch)
        }
      }
      window.addEventListener('message', onChildMessage)

      // Live observe: nudge the frame when the workspace changes, for each observe
      // topic the extension was granted, so its api.*.subscribe listeners re-read.
      // The nudge carries no data — the child re-reads via the grant-gated observe()
      // — so this cannot leak state to an ungranted extension; gating the SUBSCRIPTION
      // here is only to avoid waking a frame that could not read anyway. Coalesced so
      // a burst of store writes becomes one nudge, not one per write.
      let storeUnsub: (() => void) | null = null
      let observeDisposed = false
      let nudgeTimer: ReturnType<typeof setTimeout> | null = null
      void window.api.extensionGrantedCapabilities(extensionId).then(granted => {
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
        setStatus('ready')
        // Tell the child which of its registered views to mount. This is the
        // frame equivalent of calling the returned ViewMount in the same realm.
        frameHost.push({ kind: 'agent-code-ext:mount', viewId })
        pushTheme()
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
      iframe.src =
        `agent-code-ext://${extensionId}/__agent-code-frame__.html` +
        `?view=${encodeURIComponent(viewId)}` +
        `&parentOrigin=${encodeURIComponent(window.location.origin)}`

      return () => {
        iframe.removeEventListener('load', onLoad)
        iframe.removeEventListener('error', onError)
        window.removeEventListener('message', onChildMessage)
        window.removeEventListener(THEME_CHANGED_EVENT, pushTheme)
        observeDisposed = true
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

    return (
      <div className={fill ? 'relative h-full w-full' : 'relative min-h-[120px]'}>
        {status === 'loading' ? (
          <div className="px-6 py-8 text-[12px] text-muted">Loading {entry.manifest.name}…</div>
        ) : null}
        {status === 'failed' ? (
          <div className="px-6 py-8">
            <div className="text-[13px] text-ink">{entry.manifest.name} failed to start</div>
            <div className="mt-1 text-[12px] text-muted">
              The extension frame could not be loaded.
            </div>
          </div>
        ) : null}
        {/* Always present so the ref exists before the effect runs. No `sandbox`
            attribute on purpose: the isolation comes from the distinct
            agent-code-ext://<id> origin + the child CSP, and `sandbox` would give
            the frame an opaque "null" origin, breaking the origin-derived identity
            the whole broker depends on. */}
        <iframe
          ref={iframeRef}
          title={entry.manifest.name}
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
          }}
        />
      </div>
    )
  }
}
