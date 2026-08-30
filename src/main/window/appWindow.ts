import { BrowserWindow, dialog } from 'electron'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import { openAllowedExternalUrl } from '@main/window/externalNavigation.js'
// The window's geometry type is the PERSISTED one on purpose: bounds only
// exist here to be saved and restored, and two structurally identical
// `WindowBounds` declarations would be free to drift apart.
import type { WindowBounds } from '@main/storage/workspaceFile.js'

// Construction of ONE Agent Code window.
//
// WHY this is separate from windowRegistry.ts: the registry answers "which
// window should hear this?" — a process-wide routing question — while this
// module answers "what is a window?". Before multi-window both lived in
// mainWindow.ts together with a module-scoped singleton, which is exactly what
// made "send to the window" expressible. Splitting them means a new outbound
// message cannot be written without naming a target, because there is no
// ambient window in scope here at all.
//
// Everything installed below was already installed on the single window. None
// of it was ever about THE window; it was about A window. The comments are the
// originals — each one records a real bug — and they now apply per window.

const __dirname = dirname(fileURLToPath(import.meta.url))

const MIN_ZOOM_LEVEL = -2
const MAX_ZOOM_LEVEL = 2
const ZOOM_STEP = 1

export type AppWindowHooks = {
  /** Called when this window takes focus, so the registry can keep its
   *  most-recently-focused order for `sendToFocusedWindow`. */
  onFocused: () => void
  /** Called once the BrowserWindow is destroyed, so the registry can drop it. */
  onClosed: () => void
  /** Called while the window is closing but still alive, BEFORE teardown, so
   *  the close path can hand this window's workspace to a survivor. Returning
   *  nothing is fine; the registry decides whether a bequest applies. */
  onClosing: () => void
  /**
   * Called when a close that already fired `onClosing` is ABORTED — the user
   * chose "Keep Editing" at the unsaved-changes sheet.
   *
   * WHY this is not optional: Electron emits `close` before the renderer's
   * `beforeunload` veto, so `onClosing` has already marked the window as
   * closing by the time the sheet appears. Without this, a vetoed close leaves
   * that flag latched and the window is skipped by every main→renderer send
   * for the rest of its life — panes freeze, the menu stops working, and only
   * a restart recovers. It also aborts a ⌘Q, so the quit flag has to be
   * unlatched here for the same reason.
   */
  onCloseVetoed: () => void
  /**
   * Called whenever the window is moved, resized, or changes full-screen state.
   *
   * WHY geometry cannot just ride along on the next workspace save: dragging a
   * window to the other monitor and quitting changes nothing the renderer knows
   * about, so it produces no autosave. The one promise this whole feature makes
   * — "it comes back on the display you left it on" — would then depend on the
   * user happening to touch a pane afterwards. The registry debounces these.
   */
  onGeometryChanged: () => void
}

const DEFAULT_WIDTH = 1400
const DEFAULT_HEIGHT = 900

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
function pushTrafficLightInset(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  // getWindowButtonPosition returns { x, y } of the top-left of the
  // FIRST button (close). The three buttons are each ~14px wide with
  // ~6px gaps, arranged left-to-right: close, minimize, zoom. The
  // right edge of the zoom button is roughly x + 68 CSS pixels at 1x
  // scale. But we want to be precise, so we add a comfortable margin
  // past the reported x position. The x value already accounts for
  // the hiddenInset padding.
  try {
    const pos = window.getWindowButtonPosition()
    if (pos) {
      // pos.x is the left edge of the close button. The three buttons
      // span ~54px total, plus we want ~8px breathing room after the
      // last button. Round up to avoid sub-pixel clipping.
      const inset = Math.ceil(pos.x + 62)
      window.webContents.send('traffic-light-inset', inset)
    }
  } catch {
    // getWindowButtonPosition throws on non-macOS. Silently skip —
    // the renderer defaults to 0.
  }
}

export function zoomBrowserWindow(
  window: BrowserWindow,
  direction: 'in' | 'out' | 'reset',
): void {
  if (window.isDestroyed()) return

  const current = window.webContents.getZoomLevel()
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
  //
  // WHY zoom is per window and not per app: it is a property of the display the
  // window sits on. A 4K second monitor and a laptop panel want different zoom,
  // and the whole reason a second window exists is that the two displays are
  // different.
  window.webContents.setZoomLevel(clampZoomLevel(next))
  pushTrafficLightInset(window)
}

function handleZoomInput(
  window: BrowserWindow,
  event: Electron.Event,
  input: Electron.Input,
): void {
  const isCommandZoom =
    process.platform === 'darwin' ? input.meta : input.control
  if (!isCommandZoom || input.alt) return

  const key = input.key.toLowerCase()
  if (key === '+' || key === '=') {
    event.preventDefault()
    zoomBrowserWindow(window, 'in')
    return
  }

  if (key === '-' || key === '_') {
    event.preventDefault()
    zoomBrowserWindow(window, 'out')
    return
  }

  if (key === '0') {
    event.preventDefault()
    zoomBrowserWindow(window, 'reset')
  }
}

export function buildAppWindow(options: {
  bounds: WindowBounds | null
  fullScreen: boolean
  hooks: AppWindowHooks
}): BrowserWindow {
  const { bounds, fullScreen, hooks } = options

  const window = new BrowserWindow({
    ...(bounds ?? { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }),
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0a',
    webPreferences: {
      // WHY the renderer is NOT told its own window id: it never needs one.
      // Every window-scoped IPC handler resolves the window from
      // `event.sender`, so identity is main's business and the renderer keeps
      // exactly the API it had before multi-window. Handing it an id would
      // create a second source of truth for "which window am I" that could
      // disagree with the registry after a reload.
      //
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
      // WHY Agent Code opts out of Chromium's background scheduler suspension: workflows and
      // provider sessions keep producing durable state while the window is occluded or lives on a
      // different macOS Space. On Electron 31/macOS 26 we captured a foreground-visible renderer
      // whose heartbeat stopped for 20+ seconds while its native main thread slept in a condition
      // wait; Electron never emitted `unresponsive`, main stayed healthy, and the next workflow IPC
      // hint could not wake the page. That is the signature of lifecycle throttling, not expensive
      // React work. A brief power saving is not worth making the control plane appear crashed or
      // forcing a huge catch-up burst when the window returns. This also makes Page Visibility stay
      // `visible`, which gives workflow polling one stable contract across occlusion/fullscreen
      // transitions instead of relying on Chromium's platform-specific timer budget.
      //
      // This matters MORE with several windows, not less: a second monitor's
      // window is frequently the occluded one while its agents keep working.
      backgroundThrottling: false,
    },
  })

  window.on('ready-to-show', () => {
    window.show()
    // WHY full screen is entered AFTER show() rather than at construction:
    // entering full screen on a window that is still hidden makes macOS run the
    // space transition against a window it is about to reveal, which is a
    // well-known source of a black or mispositioned window. Restoring a
    // full-screen window is a first-class case here, so it takes the ordering
    // that survives the transition.
    if (fullScreen) window.setFullScreen(true)
    pushTrafficLightInset(window)
  })

  window.on('focus', hooks.onFocused)
  // WHY 'close' and not 'closed': the bequest needs the renderer alive to hand
  // over its workspace, and 'closed' fires after teardown when webContents is
  // already gone.
  window.on('close', hooks.onClosing)
  window.on('closed', hooks.onClosed)

  // Recompute the traffic light inset whenever the window geometry
  // changes — zoom level, display scale, fullscreen toggle. Electron
  // doesn't offer a "traffic light moved" event, but resize covers
  // every case that shifts them.
  window.on('resize', () => {
    pushTrafficLightInset(window)
    hooks.onGeometryChanged()
  })
  // `moved` is macOS/Windows only and is the event that matters most here:
  // dragging a window to the second monitor fires it and nothing else.
  window.on('moved', hooks.onGeometryChanged)
  window.on('enter-full-screen', hooks.onGeometryChanged)
  window.on('leave-full-screen', hooks.onGeometryChanged)

  // ALSO re-push after every renderer load. ready-to-show fires once per
  // window, so a renderer reload (Cmd+R, crash recovery, vite full
  // reload) got a fresh React tree that never received the inset — the
  // spacer collapsed to 0, tabs slid under the traffic lights, and the
  // tab bar's built-in drag strip vanished until the next manual resize.
  // did-finish-load fires on every navigation/reload, and the renderer
  // subscribes in a mount effect that runs before this event's IPC
  // round-trip can complete, so the push always lands on a listener.
  window.webContents.on('did-finish-load', () => pushTrafficLightInset(window))

  window.webContents.on('before-input-event', (event, input) =>
    handleZoomInput(window, event, input),
  )

  window.webContents.on('zoom-changed', (event, zoomDirection) => {
    // WHY the menu accelerator is not the only zoom entry point: Chromium can
    // still produce zoom gestures outside the menu path on some platforms and
    // keyboard layouts. If those gestures use Chromium's default behavior, the
    // app drifts back into unbounded browser zoom even though the visible menu
    // is capped. Preventing the default here translates every user zoom gesture
    // back through the same clamped helper as the menu commands.
    event.preventDefault()
    zoomBrowserWindow(window, zoomDirection === 'in' ? 'in' : 'out')
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    void openAllowedExternalUrl(url).catch(err => {
      console.warn('[window] blocked or failed external open:', err)
    })
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', event => {
    // WHY this blocks even after renderer markdown links call preventDefault:
    // rendered assistant/provider content is untrusted, and Electron's app
    // window is not a browser tab. If any future markdown surface forgets the
    // shared safe-link component, or any raw anchor slips through a regression,
    // the fallback behavior must be "stay in Agent Code" instead of navigating
    // the privileged BrowserWindow to arbitrary model-controlled content.
    event.preventDefault()
  })

  window.webContents.on('will-prevent-unload', event => {
    if (window.isDestroyed()) return
    // The renderer can only veto an unload; Chromium intentionally ignores its
    // custom message and Electron does not show browser confirmation UI for us.
    // Resolve that veto here with an explicit native decision. In Electron's
    // counterintuitive contract, preventDefault on *this* event means "ignore
    // the renderer veto and continue unloading", so only the destructive
    // button takes that branch.
    //
    // WITH SEVERAL WINDOWS this can prompt once per window during a quit. That
    // is correct rather than merely tolerable: each dialog names the unsaved
    // work of one window, and collapsing them into a single app-wide prompt
    // would ask the user to discard edits they cannot see.
    const discard = dialog.showMessageBoxSync(window, {
      type: 'warning',
      title: 'Unsaved editor changes',
      message: 'Leave Agent Code and discard unsaved editor changes?',
      detail:
        'One or more project or AI Workspace files contain edits that have not been saved. Deleted files with an in-memory recovery copy are included.',
      buttons: ['Keep Editing', 'Discard Changes and Leave'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    if (discard === 1) {
      event.preventDefault()
      return
    }
    // "Keep Editing": the close (and any quit that triggered it) is aborted.
    // Everything that was armed on `close` has to be disarmed here — see
    // `onCloseVetoed`.
    hooks.onCloseVetoed()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}
