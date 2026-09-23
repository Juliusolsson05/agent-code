import { useEffect, useRef } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { useGlobalToast } from '@renderer/ui/GlobalToast'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { SessionId } from '@renderer/workspace/types'
import type { ForwardedKey } from '@shared/browserPocket/types'

import { attachPocket, defaultMint, setPocketViewport } from '../actions'
import { requestPocket, setOpenInPocketHandler } from '../state/pocketBus'
import { usePocketLiveStore } from '../state/pocketLiveStore'
import { useLanePortsStore } from '../state/lanePortsStore'
import { usePortWatchFeed } from './usePortWatchFeed'

/**
 * Every renderer ↔ main channel of the pocket, mounted once by the host.
 * Kept in one hook so the host component is about placing guests, not about
 * plumbing.
 */
export function usePocketBridges(workspace: Workspace, enabled: boolean): void {
  const allowEvaluate = useAppStore(s => s.settings.browserPocketAllowEvaluate)
  const { showToast } = useGlobalToast()
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace

  // Main registers browser_* tools and accepts guests only while enabled.
  useEffect(() => {
    void window.api.setPocketFlags({ enabled, allowEvaluate })
  }, [enabled, allowEvaluate])

  useEffect(() => {
    // Turning the feature off unsubscribes below before main's final "no
    // ports" broadcast can arrive, so clear the chips here.
    if (!enabled) { useLanePortsStore.getState().replace({}); return }
    const offs = [
      // App chords pressed while a page had focus (main caught them on the
      // guest). Re-dispatched to the ONE keybinding router, which listens on
      // document in the capture phase, so user rebinds apply unchanged.
      window.api.onPocketChord(key => document.dispatchEvent(keyboardEventFor(key))),
      window.api.onPocketLocalAction(({ pocketId, action }) => {
        if (action === 'reload') requestPocket(pocketId, { type: 'reload' })
        else if (action === 'hardReload') requestPocket(pocketId, { type: 'reload', hard: true })
        else if (action === 'focusAddress') requestPocket(pocketId, { type: 'focus-address' })
        else requestPocket(pocketId, { type: 'pick' })
      }),
      window.api.onPocketBlockedPopup(({ url }) => {
        showToast(`The page tried to open a popup (${hostOf(url)}). Use ↗ to continue in your browser.`)
      }),
      // An agent called browser_open. The pocket is attached COLLAPSED and
      // nothing takes focus: the user keeps what they were doing and sees the
      // strip light up (Cursor 145239 / Codex 32363 complaints).
      window.api.onPocketOpenRequest(({ sessionId, url }) => {
        const ws = workspaceRef.current
        const before = ws.state.sessions[sessionId]?.browserPocket
        // Mint the id HERE so the pocket can be marked as wanted before the
        // workspace update lands: main only asks when it has no registered
        // guest (none yet, or the pocket is asleep), and a collapsed pocket
        // with no slot would otherwise never get one (review round 2, B #1).
        const pocketId = before?.pocketId ?? defaultMint()
        ws.updateBrowserPocket(s => attachPocket(s, sessionId as SessionId, before ? (url ? { url } : undefined) : { view: 'collapsed', ...(url ? { url } : {}) }, () => pocketId))
        const live = usePocketLiveStore.getState()
        live.patch(pocketId, { agentOpening: true, asleep: false })
        // main gives up after 8 s; stop holding a painting guest for a tool
        // call that is already over.
        setTimeout(() => usePocketLiveStore.getState().patch(pocketId, { agentOpening: false }), 10_000)
        if (before && url && before.url !== url) requestPocket(before.pocketId, { type: 'navigate', url })
      }),
      window.api.onPocketPorts(({ bySession }) => useLanePortsStore.getState().replace(bySession)),
      // browser_resize: the pocket's viewport is renderer-owned config, so the
      // user's device menu and the agent's tool write the same field.
      window.api.onPocketViewportRequest(({ sessionId, viewport }) => {
        workspaceRef.current.updateBrowserPocket(s => setPocketViewport(s, sessionId as SessionId, viewport))
      }),
      // Driving state only; the host turns "an agent is driving" into
      // "keep this guest painting" itself (placement is host-private).
      window.api.onPocketDriving(event => {
        usePocketLiveStore.getState().patch(event.pocketId, prev => ({
          driving: event.state,
          drivingAction: event.action ?? (event.state === 'agent' ? prev.drivingAction : null),
          drivingPoint: event.point ?? prev.drivingPoint,
          drivingAt: Date.now(),
        }))
      }),
    ]
    return () => { for (const off of offs) off() }
  }, [enabled, showToast])

  const localhostLinks = useAppStore(s => s.settings.browserPocketOpenLocalhostLinks)
  useEffect(() => {
    if (!enabled || !localhostLinks) { setOpenInPocketHandler(null); return }
    setOpenInPocketHandler((sessionId, url) => {
      // The Reader hides the lanes: a pocket opened now would be invisible and
      // the click would look like a no-op (review B #10). Let it go external.
      if (useAppStore.getState().workspaceReaderMode) return false
      const ws = workspaceRef.current
      const before = ws.state.sessions[sessionId]?.browserPocket
      const next = attachPocket(ws.state, sessionId as SessionId, { url, view: 'open' })
      if (next === ws.state && !before) return false // not an agent: let the link go external
      ws.updateBrowserPocket(s => attachPocket(s, sessionId as SessionId, { url, view: 'open' }))
      if (before) requestPocket(before.pocketId, { type: 'navigate', url })
      return true
    })
    return () => setOpenInPocketHandler(null)
  }, [enabled, localhostLinks])

  usePortWatchFeed(workspace, enabled)
}

/**
 * Replays a key caught on a focused guest as a keydown on document, where the
 * app's one router listens (capture phase). It carries the ORIGINAL key and
 * code, so the router's shared grammar normalizes it to the same chord main
 * matched — including Option chords, whose `key` is a symbol on macOS.
 */
export function keyboardEventFor(key: ForwardedKey): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key: key.key, code: key.code,
    metaKey: key.meta, ctrlKey: key.ctrl, altKey: key.alt, shiftKey: key.shift,
    bubbles: true, cancelable: true,
  })
}

function hostOf(url: string): string {
  try { return new URL(url).host } catch { return url }
}
