import { BrowserWindow, dialog } from 'electron'
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
// Optional passive observer of the outbound IPC stream. Session recording
// (src/main/recording/, plan §2) registers here to capture the exact
// payloads the renderer receives, WITHOUT coupling this window helper to
// the recorder — it just calls the hook if one is installed. Null (and
// therefore zero cost) unless recording is gated on.
type OutboundObserver = (channel: string, args: readonly unknown[]) => void
let outboundObserver: OutboundObserver | null = null

type OutboundIpcBreadcrumb = {
  at: number
  channel: string
  metadata: Record<string, string | number | boolean>
}

const OUTBOUND_IPC_BREADCRUMB_LIMIT = 32
const outboundIpcBreadcrumbs = new Array<OutboundIpcBreadcrumb | undefined>(
  OUTBOUND_IPC_BREADCRUMB_LIMIT,
)
let outboundIpcBreadcrumbCount = 0
let outboundIpcBreadcrumbWriteIndex = 0
const outboundIpcCounts = new Map<string, { count: number; lastAt: number }>()

export function setOutboundObserver(observer: OutboundObserver | null): void {
  outboundObserver = observer
}

export function getOutboundIpcDiagnostics(): {
  recent: OutboundIpcBreadcrumb[]
  counts: Array<{ channel: string; count: number; lastAt: number }>
} {
  // Return copies because the freeze logger serializes asynchronously from the same main-process
  // structures that hot session traffic continues mutating. A stable diagnostic snapshot matters
  // more than saving two tiny allocations on a path that only runs after a detected stall.
  return {
    recent: readOutboundIpcBreadcrumbs(),
    counts: [...outboundIpcCounts.entries()]
      .map(([channel, value]) => ({ channel, ...value }))
      .sort((left, right) => right.lastAt - left.lastAt),
  }
}

export function sendToMainWindow(channel: string, ...args: unknown[]): void {
  recordOutboundIpcBreadcrumb(channel, args)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
  // Observe AFTER the send so recording can never delay or break delivery.
  // The observer must not throw; it is a try/caught diagnostic sink.
  if (outboundObserver) {
    try {
      outboundObserver(channel, args)
    } catch {
      /* recording is a diagnostic; never let it break IPC */
    }
  }
}

export function recordIpcDiagnosticBreadcrumb(
  channel: string,
  metadata: Record<string, string | number | boolean>,
): void {
  // WHY request/response milestones share the bounded outbound ring: a renderer freeze often sits
  // exactly between a main-process IPC response and its renderer acknowledgement. OpenTelemetry
  // spans eventually reach disk but were missing request cursors and response sizes in the copied
  // terminal snapshot. This metadata-only hook makes that causal edge visible without retaining
  // prompts, commands, output, or arbitrary IPC arguments.
  const at = Date.now()
  const previous = outboundIpcCounts.get(channel)
  outboundIpcCounts.set(channel, { count: (previous?.count ?? 0) + 1, lastAt: at })
  appendOutboundIpcBreadcrumb({
    at,
    channel,
    metadata: sanitizeDiagnosticMetadata(metadata),
  })
}

function recordOutboundIpcBreadcrumb(channel: string, args: readonly unknown[]): void {
  const at = Date.now()
  const previous = outboundIpcCounts.get(channel)
  outboundIpcCounts.set(channel, { count: (previous?.count ?? 0) + 1, lastAt: at })
  appendOutboundIpcBreadcrumb({
    at,
    channel,
    metadata: outboundMetadata(args),
  })
}

function appendOutboundIpcBreadcrumb(item: OutboundIpcBreadcrumb): void {
  // WHY this is a fixed ring rather than push/splice: this function is on the
  // IPC hot path. A prolonged stream must replace one slot without growing an
  // array, shifting old entries, or retaining arguments beyond their metadata.
  outboundIpcBreadcrumbs[outboundIpcBreadcrumbWriteIndex] = item
  outboundIpcBreadcrumbWriteIndex =
    (outboundIpcBreadcrumbWriteIndex + 1) % OUTBOUND_IPC_BREADCRUMB_LIMIT
  outboundIpcBreadcrumbCount = Math.min(
    outboundIpcBreadcrumbCount + 1,
    OUTBOUND_IPC_BREADCRUMB_LIMIT,
  )
}

function readOutboundIpcBreadcrumbs(): OutboundIpcBreadcrumb[] {
  const result: OutboundIpcBreadcrumb[] = []
  const start = outboundIpcBreadcrumbCount < OUTBOUND_IPC_BREADCRUMB_LIMIT
    ? 0
    : outboundIpcBreadcrumbWriteIndex
  for (let offset = 0; offset < outboundIpcBreadcrumbCount; offset += 1) {
    const item = outboundIpcBreadcrumbs[
      (start + offset) % OUTBOUND_IPC_BREADCRUMB_LIMIT
    ]
    if (item) result.push({ ...item, metadata: { ...item.metadata } })
  }
  return result
}

function outboundMetadata(args: readonly unknown[]): Record<string, string | number | boolean> {
  const metadata: Record<string, string | number | boolean> = { argumentCount: args.length }
  const payload = asRecord(args[0])
  if (!payload) {
    if (typeof args[0] === 'string') metadata.firstStringLength = args[0].length
    return metadata
  }

  // WHY this intentionally captures shape, not content: the freeze line belongs in the terminal
  // and can therefore outlive debug-retention cleanup or be pasted into an issue. Identifiers,
  // event families, and collection/string sizes are enough to identify a transport avalanche;
  // prompts, tool input, terminal bytes, and assistant output are both noisy and potentially
  // sensitive, so none of their actual text belongs in this always-on breadcrumb ring. Even
  // identifier and event-family fields are represented only by length; their expected shape is not
  // a trustworthy guarantee once provider data crosses the boundary.
  copyStringLength(payload, metadata, 'sessionId')
  copyStringLength(payload, metadata, 'runId')
  copyStringLength(payload, metadata, 'type')
  copyNumberMetadata(payload, metadata, 'fromCursor')
  copyNumberMetadata(payload, metadata, 'toCursor')
  copyNumberMetadata(payload, metadata, 'rawEventCount')
  copyCollectionLength(payload, metadata, 'events')
  copyCollectionLength(payload, metadata, 'entries')
  copyCollectionLength(payload, metadata, 'runs')
  copyStringLength(payload, metadata, 'data')
  copyStringLength(payload, metadata, 'screen')
  const event = asRecord(payload.event)
  if (event && typeof event.type === 'string') metadata.eventTypeLength = event.type.length
  return metadata
}

function sanitizeDiagnosticMetadata(
  source: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(source).slice(0, 24)) {
    if (typeof value !== 'string') {
      result[key] = value
      continue
    }
    // WHY no renderer/provider string is ever copied verbatim: names such as `runId`, `type`, or
    // `code` describe expected shape, not trustworthy provenance. A malformed payload can place a
    // prompt, command, token, or path in any of them. Counts and lengths retain avalanche evidence
    // without attempting an impossible content classifier at the terminal logging boundary.
    result[`${key}Length`] = value.length
  }
  return result
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function copyNumberMetadata(
  source: Record<string, unknown>,
  target: Record<string, string | number | boolean>,
  key: string,
): void {
  if (typeof source[key] === 'number' && Number.isFinite(source[key])) target[key] = source[key]
}

function copyCollectionLength(
  source: Record<string, unknown>,
  target: Record<string, string | number | boolean>,
  key: string,
): void {
  if (Array.isArray(source[key])) target[`${key}Count`] = source[key].length
}

function copyStringLength(
  source: Record<string, unknown>,
  target: Record<string, string | number | boolean>,
  key: string,
): void {
  if (typeof source[key] === 'string') target[`${key}Length`] = source[key].length
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
      backgroundThrottling: false,
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

  // ALSO re-push after every renderer load. ready-to-show fires once per
  // window, so a renderer reload (Cmd+R, crash recovery, vite full
  // reload) got a fresh React tree that never received the inset — the
  // spacer collapsed to 0, tabs slid under the traffic lights, and the
  // tab bar's built-in drag strip vanished until the next manual resize.
  // did-finish-load fires on every navigation/reload, and the renderer
  // subscribes in a mount effect that runs before this event's IPC
  // round-trip can complete, so the push always lands on a listener.
  mainWindow.webContents.on('did-finish-load', pushTrafficLightInset)

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

  mainWindow.webContents.on('will-prevent-unload', event => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    // The renderer can only veto an unload; Chromium intentionally ignores its
    // custom message and Electron does not show browser confirmation UI for us.
    // Resolve that veto here with an explicit native decision. In Electron's
    // counterintuitive contract, preventDefault on *this* event means "ignore
    // the renderer veto and continue unloading", so only the destructive
    // button takes that branch.
    const discard = dialog.showMessageBoxSync(mainWindow, {
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
    if (discard === 1) event.preventDefault()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}
