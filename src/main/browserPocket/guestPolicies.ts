import { isAllowedTopLevelUrl } from '@shared/browserPocket/url.js'
import { keybindingFromEvent } from '@shared/keybindings.js'
import type { ForwardedKey } from '@shared/browserPocket/types.js'

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

type InputLike = { type: string; key: string; code: string; alt: boolean; meta: boolean; control: boolean; shift: boolean; isAutoRepeat?: boolean; isComposing?: boolean }

/**
 * Electron's `before-input-event` input → the app's canonical chord, through
 * the SAME grammar the renderer router and the extension input gate use
 * (@shared/keybindings). It reads the physical `code`, which is what makes ⌥S
 * work on macOS, where the `key` is "ß". An earlier draft had its own
 * key-based formatter here; it would have missed every Option chord.
 */
export function chordFromInput(input: InputLike): string | null {
  if (input.type !== 'keyDown' || input.isComposing) return null
  return keybindingFromEvent({ key: input.key, code: input.code, metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift })
}

/** What main sends the renderer so it can replay the key into the router. */
export function forwardedKeyFromInput(input: InputLike): ForwardedKey {
  return { key: input.key, code: input.code, meta: input.meta, ctrl: input.control, alt: input.alt, shift: input.shift }
}

export type GuestInputDeps = {
  forwardChord: (key: ForwardedKey) => void
  localAction: (action: keyof typeof POCKET_LOCAL_CHORDS) => void
  /** A trusted key or mouse-down from the human (spec §6.5 takeover). */
  onHumanInput: (at?: { x: number; y: number }) => void
  /**
   * True while the controller is dispatching the agent's own CDP keys.
   * Whether CDP key events pass through before-input-event is unverified
   * (decomposition U6); if they do, an agent's browser_press of ⌘W must reach
   * the PAGE, never be forwarded to the app as "close tab" (review A #5).
   */
  agentTyping: () => boolean
}

/**
 * Navigation, popup and scheme rules. Attached at ATTACH time
 * (did-attach-webview, see guestGuard.installGuestGuard) — not when the
 * renderer registers the guest over IPC — so a <webview> created by any
 * renderer script is guarded even if it never registers (review A #1).
 */
export function attachGuestSecurity(guest: Electron.WebContents, deps: { onBlockedPopup: (url: string) => void }): void {
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
}

/** Keys and pointer: chord forwarding, page-local chords, takeover reports.
 * Attached on registration, because it needs to know which pocket it is. */
export function attachGuestInput(guest: Electron.WebContents, deps: GuestInputDeps): void {
  guest.on('before-input-event', (event, input) => {
    // The agent's own CDP keys (if they echo here at all) go to the page.
    if (deps.agentTyping()) return
    const chord = chordFromInput(input)
    if (chord) {
      for (const [action, chords] of Object.entries(POCKET_LOCAL_CHORDS) as Array<[keyof typeof POCKET_LOCAL_CHORDS, Set<string>]>) {
        if (chords.has(chord)) { event.preventDefault(); deps.localAction(action); return }
      }
      if (POCKET_FORWARDED_CHORDS.has(chord)) { event.preventDefault(); deps.forwardChord(forwardedKeyFromInput(input)); return }
    }
    // A keystroke here MAY be the user taking control (spec §6.5). This only
    // REPORTS; the controller decides, filtering input it dispatched itself.
    if (input.type === 'keyDown') deps.onHumanInput()
  })
  guest.on('input-event', (_event, input) => {
    if (input.type === 'mouseDown') {
      const mouse = input as Electron.MouseInputEvent
      deps.onHumanInput(typeof mouse.x === 'number' ? { x: mouse.x, y: mouse.y } : undefined)
    }
  })
}
