import { isAllowedTopLevelUrl } from '@shared/browserPocket/url.js'

/**
 * App chords that must keep working while a pocket page has focus.
 *
 * WHY: a focused <webview> swallows key events and the HOST window's
 * before-input-event never fires (electron#14905/#14258). Main listens on each
 * GUEST's webContents instead, stops these chords reaching the page, and
 * re-dispatches them to the renderer's one keybinding router. Keep it short:
 * everything not listed belongs to the page (a web app's own shortcuts).
 * Format matches features/command-keybindings/defaults.ts.
 */
export const POCKET_FORWARDED_CHORDS: ReadonlySet<string> = new Set([
  'Alt+S', 'Cmd+Shift+B', 'Cmd+P', 'Cmd+Shift+P', 'Cmd+G', 'Cmd+Shift+G', 'Cmd+,',
  'Alt+Left', 'Alt+Right', 'Alt+Up', 'Alt+Down', 'Alt+H', 'Alt+J', 'Alt+K', 'Alt+L',
  'Cmd+T', 'Cmd+W', 'Cmd+N',
])

/**
 * Chords handled for the pocket itself, inside main, while the page has focus.
 *
 * Two of them shadow app bindings ON PURPOSE, the way Monaco shadows ⌘G/⌘⇧G
 * while the editor owns focus: ⌘L (app: TLDR peek) focuses the address bar and
 * ⌘⇧R (app: Resume Session) hard-reloads, because inside a web page those are
 * the browser's own chords and the user expects them. They are NOT listed in
 * command-keybindings/reservations.ts: the app's router never sees keystrokes
 * while a guest has focus, so there is no router-level collision to check, and
 * a global reservation would falsely flag the app's own bindings.
 */
export const POCKET_LOCAL_CHORDS = {
  reload: new Set(['Cmd+R', 'Ctrl+R', 'F5']),
  hardReload: new Set(['Cmd+Shift+R', 'Ctrl+Shift+R']),
  focusAddress: new Set(['Cmd+L', 'Ctrl+L']),
  pick: new Set(['Cmd+Shift+S', 'Ctrl+Shift+S']),
} as const

type InputLike = { type: string; key: string; alt: boolean; meta: boolean; control: boolean; shift: boolean }

/** Electron's `before-input-event` input → the chord syntax our keybindings use. */
export function chordFromInput(input: InputLike): string | null {
  if (input.type !== 'keyDown') return null
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(input.key)) return null
  const key = input.key.length === 1 ? input.key.toUpperCase() : input.key.replace(/^Arrow/, '')
  return [input.meta && 'Cmd', input.control && 'Ctrl', input.alt && 'Alt', input.shift && 'Shift', key].filter(Boolean).join('+')
}

export type GuestPolicyDeps = {
  forwardChord: (chord: string) => void
  localAction: (action: keyof typeof POCKET_LOCAL_CHORDS) => void
  /** A trusted key or mouse-down from the human (spec §6.5 takeover). */
  onHumanInput: (at?: { x: number; y: number }) => void
  /** A popup the pocket will not open itself (D9): offer the system browser. */
  onBlockedPopup: (url: string) => void
}

export function attachGuestPolicies(guest: Electron.WebContents, deps: GuestPolicyDeps): void {
  // _blank links and window.open to the web load in the same pocket: one page
  // per pocket (D3). A popup that NEEDS window.opener (OAuth) would break that
  // way, so non-navigational dispositions are refused with an offer to open
  // the system browser instead (D9).
  guest.setWindowOpenHandler(({ url, disposition }) => {
    if (!isAllowedTopLevelUrl(url)) return { action: 'deny' }
    if (disposition === 'new-window') deps.onBlockedPopup(url)
    else void guest.loadURL(url)
    return { action: 'deny' }
  })
  // The page itself must not navigate to file:, javascript:, custom schemes.
  // T3 Code filtered only its address bar, so a page could go anywhere.
  const guardNav = (event: Electron.Event, url: string) => {
    if (!isAllowedTopLevelUrl(url) && url !== 'about:blank') event.preventDefault()
  }
  guest.on('will-navigate', guardNav)
  guest.on('will-redirect', guardNav)
  guest.on('will-frame-navigate', details => {
    if (details.isMainFrame && !isAllowedTopLevelUrl(details.url) && details.url !== 'about:blank') details.preventDefault()
  })

  guest.on('before-input-event', (event, input) => {
    const chord = chordFromInput(input)
    if (chord) {
      for (const [action, chords] of Object.entries(POCKET_LOCAL_CHORDS) as Array<[keyof typeof POCKET_LOCAL_CHORDS, Set<string>]>) {
        if (chords.has(chord)) { event.preventDefault(); deps.localAction(action); return }
      }
      if (POCKET_FORWARDED_CHORDS.has(chord)) { event.preventDefault(); deps.forwardChord(chord); return }
    }
    // A keystroke here MAY be the user taking control (spec §6.5) — or may be
    // the agent's own CDP Input.dispatchKeyEvent echoing through: whether CDP
    // input passes before-input-event on 43.7.x is unverified (decomposition
    // U6). So this only REPORTS; the controller decides, filtering out input
    // it is dispatching itself.
    if (input.type === 'keyDown') deps.onHumanInput()
  })
  guest.on('input-event', (_event, input) => {
    if (input.type === 'mouseDown') {
      const mouse = input as Electron.MouseInputEvent
      deps.onHumanInput(typeof mouse.x === 'number' ? { x: mouse.x, y: mouse.y } : undefined)
    }
  })
}
