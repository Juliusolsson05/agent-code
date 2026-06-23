import { BrowserWindow } from 'electron'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import { openAllowedExternalUrl } from '@main/window/externalNavigation.js'

// The main BrowserWindow lives here, and so does the one helper
// everything else uses to push messages to it (sendToMainWindow). We
// keep the reference module-scoped and expose it through functions so
// consumers don't accidentally hold a stale BrowserWindow across a
// reload. If we ever add a second window, this module grows a
// per-role registry; for now the single-window assumption is baked in
// and explicit.

const __dirname = dirname(fileURLToPath(import.meta.url))

let mainWindow: BrowserWindow | null = null

const MIN_ZOOM_LEVEL = -2
const MAX_ZOOM_LEVEL = 2
const ZOOM_STEP = 1

function clampZoomLevel(level: number): number {
  return Math.max(MIN_ZOOM_LEVEL, Math.min(MAX_ZOOM_LEVEL, level))
}

/**
 * Push the traffic light (close/minimize/zoom) right-edge inset to the
 * renderer as a CSS custom property. The renderer uses this to pad the
 * tab bar so tabs don't sit under the buttons — zoom-safe, scale-safe,
 * no magic pixel values.
 *
 * On non-macOS platforms or when the position isn't available, falls
 * back to 0 (no inset needed — the title bar is separate).
 */
function pushTrafficLightInset(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  // getWindowButtonPosition returns { x, y } of the top-left of the
  // FIRST button (close). The three buttons are each ~14px wide with
  // ~6px gaps, arranged left-to-right: close, minimize, zoom. The
  // right edge of the zoom button is roughly x + 68 CSS pixels at 1x
  // scale. But we want to be precise, so we add a comfortable margin
  // past the reported x position. The x value already accounts for
  // the hiddenInset padding.
  try {
    const pos = mainWindow.getWindowButtonPosition()
    if (pos) {
      // pos.x is the left edge of the close button. The three buttons
      // span ~54px total, plus we want ~8px breathing room after the
      // last button. Round up to avoid sub-pixel clipping.
      const inset = Math.ceil(pos.x + 62)
      mainWindow.webContents.send('traffic-light-inset', inset)
    }
  } catch {
    // getWindowButtonPosition throws on non-macOS. Silently skip —
    // the renderer defaults to 0.
  }
}

export function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/**
 * Send an IPC message to the renderer. No-op when the window is gone
 * — callers shouldn't have to guard lifecycle around every event.
 * This is the ONE place the rest of main/ should reach into the
 * BrowserWindow; everything else goes through here.
 */
export function sendToMainWindow(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

export function zoomMainWindow(direction: 'in' | 'out' | 'reset'): void {
  if (!mainWindow || mainWindow.isDestroyed()) return

  const current = mainWindow.webContents.getZoomLevel()
  const next =
    direction === 'reset'
      ? 0
      : direction === 'in'
        ? current + ZOOM_STEP
        : current - ZOOM_STEP

  // WHY Agent Code owns zoom instead of using Electron's native zoom roles:
  // the native roles restore the missing shortcuts, but they also let Chromium
  // continue toward browser-scale extremes. Agent Code is a dense application
  // shell with fixed chrome, terminal panes, overlays, and tab geometry; very
  // high page zoom makes the UI look broken and can strand controls off-screen.
  // The intended contract is "zoom is available for comfort/accessibility, but
  // only inside the range we design and debug against." Keeping the clamp here
  // gives menu items, keyboard fallbacks, and future buttons the same policy.
  mainWindow.webContents.setZoomLevel(clampZoomLevel(next))
  pushTrafficLightInset()
}

function handleZoomInput(
  event: Electron.Event,
  input: Electron.Input,
): void {
  const isCommandZoom =
    process.platform === 'darwin' ? input.meta : input.control
  if (!isCommandZoom || input.alt) return

  const key = input.key.toLowerCase()
  if (key === '+' || key === '=') {
    event.preventDefault()
    zoomMainWindow('in')
    return
  }

  if (key === '-' || key === '_') {
    event.preventDefault()
    zoomMainWindow('out')
    return
  }

  if (key === '0') {
    event.preventDefault()
    zoomMainWindow('reset')
  }
}

export function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0a',
    webPreferences: {
      // This is a RUNTIME filesystem path, not an import — `@preload/…`
      // path aliases are resolved by vite at build time only, and don't
      // intercept Node's `path.join`. At runtime __dirname is `out/main/`
      // (the built main bundle sits there) and the preload bundle
      // electron-vite emits lives at `out/preload/index.mjs`, so the
      // relative hop is unavoidable. If this ever gets sed-rewritten to
      // '@preload/index.mjs' again, Electron fails to load the preload,
      // `window.api` is undefined in the renderer, every IPC call
      // throws on startup, and the window ends up a black rectangle.
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    pushTrafficLightInset()
  })

  // Recompute the traffic light inset whenever the window geometry
  // changes — zoom level, display scale, fullscreen toggle. Electron
  // doesn't offer a "traffic light moved" event, but resize covers
  // every case that shifts them.
  mainWindow.on('resize', pushTrafficLightInset)

  mainWindow.webContents.on('before-input-event', handleZoomInput)

  mainWindow.webContents.on('zoom-changed', (event, zoomDirection) => {
    // WHY the menu accelerator is not the only zoom entry point: Chromium can
    // still produce zoom gestures outside the menu path on some platforms and
    // keyboard layouts. If those gestures use Chromium's default behavior, the
    // app drifts back into unbounded browser zoom even though the visible menu
    // is capped. Preventing the default here translates every user zoom gesture
    // back through the same clamped helper as the menu commands.
    event.preventDefault()
    zoomMainWindow(zoomDirection === 'in' ? 'in' : 'out')
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openAllowedExternalUrl(url).catch(err => {
      console.warn('[window] blocked or failed external open:', err)
    })
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', event => {
    // WHY this blocks even after renderer markdown links call preventDefault:
    // rendered assistant/provider content is untrusted, and Electron's app
    // window is not a browser tab. If any future markdown surface forgets the
    // shared safe-link component, or any raw anchor slips through a regression,
    // the fallback behavior must be "stay in Agent Code" instead of navigating
    // the privileged BrowserWindow to arbitrary model-controlled content.
    event.preventDefault()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}
