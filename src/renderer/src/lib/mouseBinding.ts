// Mouse-button dictation trigger vocabulary.
//
// WHY this is a separate module instead of a new token inside
// hotkeyBinding.ts: the two bindings have different REACH. A keyboard
// dictation binding is registered in the MAIN process — either through
// Electron's globalShortcut or through the CGEventTap helper — so it fires
// while any application is focused. A mouse binding is a plain renderer DOM
// listener and can only fire while Agent Code itself has focus. Folding
// mouse tokens into `dictationShortcut` would mean one field whose SCOPE
// silently changed depending on the value stored in it, and "my shortcut
// only works sometimes" is the bug report that produces. Two fields, two
// unambiguous meanings, and the global keyboard path stays untouched.
//
// WHY readable names in storage rather than raw MouseEvent.button integers:
// settings blobs get read by humans during support, and `4` is unreadable
// where `Forward` is not. This is the same store-the-name/match-the-physical
// -value rule that `features/command-keybindings/normalize.ts` states for
// keys (store `Alt+D`, match `event.code === 'KeyD'`).

export type MouseButtonBinding = '' | 'Middle' | 'Back' | 'Forward'

/**
 * The bindable buttons and their DOM `MouseEvent.button` values.
 *
 * Primary (0) and secondary (2) are deliberately ABSENT and must never be
 * added. The runtime listener runs at window capture phase and calls
 * `preventDefault()` + `stopPropagation()` on a match, so binding left click
 * would swallow every click in the application and binding right click would
 * swallow the context menu — including the clicks needed to reach Settings
 * and undo it. The exclusion is a safety property of the design, not a
 * simplification of the picker.
 *
 * Back/Forward are DOM buttons 3 and 4 (the X1/X2 thumb buttons). Which
 * physical thumb button reports which number varies by mouse and by driver,
 * which is exactly why the settings control captures a real press instead of
 * offering a dropdown the user would have to guess at.
 */
export const MOUSE_BUTTON_BINDINGS: Record<Exclude<MouseButtonBinding, ''>, number> = {
  Middle: 1,
  Back: 3,
  Forward: 4,
}

/** Resolve a DOM `MouseEvent.button` to a bindable name, or null when the
 *  button is one we refuse to bind (left/right) or don't recognise. */
export function mouseButtonBindingFromButton(button: number): MouseButtonBinding | null {
  for (const [name, value] of Object.entries(MOUSE_BUTTON_BINDINGS)) {
    if (value === button) return name as MouseButtonBinding
  }
  return null
}

/**
 * Normalize a persisted value. Unlike `coerceHotkeyBinding`, this IS a closed
 * enum: keyboard bindings are arbitrary user-captured physical keys, but the
 * bindable mouse buttons are a fixed three-item product decision. Anything
 * else — a typo, a hand-edited settings file, a value from a future release
 * that added a button we no longer support — falls back to '' (off) rather
 * than arming a binding whose runtime behavior we cannot predict.
 */
export function coerceMouseButtonBinding(value: unknown): MouseButtonBinding {
  if (typeof value !== 'string') return ''
  if (value in MOUSE_BUTTON_BINDINGS) return value as MouseButtonBinding
  return ''
}

/** Display label for the settings row. Says "Side Button" rather than the
 *  raw Back/Forward names because on a mouse these are physically thumb
 *  buttons — "Back" reads as a browser action, which is the one thing this
 *  binding specifically takes away. */
export function formatMouseButtonForDisplay(value: MouseButtonBinding): string {
  if (value === 'Middle') return 'Middle Button'
  if (value === 'Back') return 'Side Button (Back)'
  if (value === 'Forward') return 'Side Button (Forward)'
  return ''
}
