import type { BrowserWindow } from 'electron'

import { isAllowedTopLevelUrl } from '@shared/browserPocket/url.js'

/**
 * Every pocket partition starts with this. `persist:` is part of the prefix on
 * purpose: an in-memory partition would lose the dev app's login every time a
 * hidden guest is put to sleep and recreated (placement/lifecycle.ts).
 */
export const POCKET_PARTITION_PREFIX = 'persist:ac-pocket-'

export type GuestAttachDecision = { allow: true } | { allow: false; reason: string }

/**
 * The whole security boundary between the privileged app renderer and a web
 * page, as a pure function so it can be tested without launching Electron.
 *
 * WHY it must fail closed: turning on `webviewTag` lets ANY script in the main
 * window create a <webview>, and that renderer exposes ~150 preload IPC methods
 * with no frame check. A renderer XSS must not be able to become a guest with
 * Node, with our preload, in the default session (which carries the app's
 * protocols and dictation microphone grant), or on a non-web URL.
 */
export function decideGuestAttach(params: { src?: string; partition?: string }): GuestAttachDecision {
  const partition = params.partition ?? ''
  if (!partition.startsWith(POCKET_PARTITION_PREFIX) || partition.length === POCKET_PARTITION_PREFIX.length) {
    return { allow: false, reason: `partition not allowed: ${partition || '(default session)'}` }
  }
  const src = params.src || 'about:blank'
  if (src !== 'about:blank' && !isAllowedTopLevelUrl(src)) {
    return { allow: false, reason: `src not allowed: ${src.slice(0, 80)}` }
  }
  return { allow: true }
}

/**
 * Electron hands us the attach's webPreferences to mutate in place.
 *
 * - No preload: anything a guest needs (automation, picker) runs from main over
 *   CDP in an isolated world. T3 Code runs guests with contextIsolation OFF so a
 *   preload can read the React DevTools hook; we have no guest preload, so we
 *   keep isolation on.
 * - backgroundThrottling ON: the MAIN window opts out of throttling
 *   (appWindow.ts) for workflow liveness, and a hidden pocket must not inherit
 *   that cost.
 */
export function hardenGuestPreferences(prefs: Electron.WebPreferences): void {
  const loose = prefs as Record<string, unknown>
  delete loose.preload
  delete loose.preloadURL
  prefs.nodeIntegration = false
  prefs.nodeIntegrationInSubFrames = false
  prefs.nodeIntegrationInWorker = false
  prefs.contextIsolation = true
  prefs.sandbox = true
  prefs.webSecurity = true
  prefs.allowRunningInsecureContent = false
  prefs.enableBlinkFeatures = ''
  prefs.backgroundThrottling = true
  prefs.webviewTag = false
}

export function installGuestGuard(window: BrowserWindow): void {
  window.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const decision = decideGuestAttach({ src: params.src, partition: params.partition })
    if (!decision.allow) {
      console.warn('[browser-pocket] refused <webview> attach:', decision.reason)
      event.preventDefault()
      return
    }
    hardenGuestPreferences(webPreferences)
  })
}
