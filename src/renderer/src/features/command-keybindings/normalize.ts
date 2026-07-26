// ---------------------------------------------------------------------------
// The keybinding grammar (governance plan, Phase 4).
//
// ONE canonical string form, used by persistence, the collision checker, the
// runtime router, the Settings editor, and the repository script. The audit's
// finding was that `CommandDef.shortcut` was a DISPLAY string with no
// relationship to `useKeybinds.ts`, which implemented the real behavior — so
// the palette could advertise ⌘S for a command the editor actually ran, and a
// user editing the displayed string would change nothing. A single parsed form
// consumed by everything is what makes a user's edit real.
//
// THE macOS PROBLEM, and why the canonical form stores a LETTER but matching
// uses a PHYSICAL CODE:
//
// On macOS, Option is the text-composition modifier. ⌥D produces "∂", ⌥C
// produces "ç", ⌥K produces "˚". So `event.key` for an Option chord is a
// glyph, not the letter the user pressed, and matching on it fails for every
// Option binding — which is most of this app's pane grammar. `event.code` is
// the physical key ("KeyD") and is stable regardless of modifier or layout.
//
// We therefore store `Alt+D` (readable, stable, what the user sees) and match
// it against `event.code === 'KeyD'`. Storing the code itself would put
// "Alt+KeyD" in a settings file a human might read, and storing `event.key`
// would put "Alt+∂" there — which is both unreadable AND wrong on a different
// keyboard layout.
// ---------------------------------------------------------------------------

/** A normalized single-step binding, e.g. `Cmd+Shift+P` or `Alt+D`. */
export type Keybinding = string

/**
 * Modifier order is FIXED, not sorted at comparison time.
 *
 * Two bindings are equal iff their canonical strings are equal, which makes
 * `Set`/`Map` the collision engine's whole implementation. That only works if
 * normalization is total — hence a fixed order applied on the way in, rather
 * than an order-insensitive comparison applied at every call site (which is
 * the version people forget in one place).
 */
const MODIFIER_ORDER = ['Cmd', 'Ctrl', 'Alt', 'Shift'] as const
type Modifier = (typeof MODIFIER_ORDER)[number]

/** Accepted spellings on the way IN. Output is always the canonical name. */
const MODIFIER_ALIASES: Record<string, Modifier> = {
  cmd: 'Cmd', command: 'Cmd', meta: 'Cmd', super: 'Cmd', '⌘': 'Cmd',
  ctrl: 'Ctrl', control: 'Ctrl', '⌃': 'Ctrl',
  alt: 'Alt', opt: 'Alt', option: 'Alt', '⌥': 'Alt',
  shift: 'Shift', '⇧': 'Shift',
}

/**
 * Named non-character keys. The canonical name is the KEY, the value is the
 * `KeyboardEvent.key` it matches.
 *
 * Arrow keys are stored as `Left`/`Right`/`Up`/`Down` rather than
 * `ArrowLeft`/… because the short form is what a Settings row should show and
 * what a person would type. The mapping to the DOM's spelling happens here,
 * once.
 */
const NAMED_KEYS: Record<string, string> = {
  Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown',
  Enter: 'Enter', Escape: 'Escape', Space: ' ', Tab: 'Tab',
  Backspace: 'Backspace', Delete: 'Delete',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
}

/**
 * Punctuation, by canonical name → physical code.
 *
 * Same reason as letters: `event.key` for `Alt+-` is "–" (en dash) on macOS.
 * The code (`Minus`) is not.
 */
const PUNCTUATION_CODES: Record<string, string> = {
  '[': 'BracketLeft', ']': 'BracketRight', '-': 'Minus', '=': 'Equal',
  ',': 'Comma', '.': 'Period', '/': 'Slash', '\\': 'Backslash',
  ';': 'Semicolon', "'": 'Quote', '`': 'Backquote',
}

export type ParsedKeybinding = {
  modifiers: readonly Modifier[]
  /** Canonical key token: `A`-`Z`, `0`-`9`, a NAMED_KEYS name, `F1`-`F20`, or punctuation. */
  key: string
}

export class KeybindingSyntaxError extends Error {}

/**
 * Parse a user- or config-supplied string into canonical form.
 *
 * Throws rather than returning null so the Settings editor and the repository
 * script can surface the SAME actionable message. A binding that silently
 * coerced to something else is how a user ends up with a chord they did not
 * choose and cannot find.
 */
export function parseKeybinding(input: string): ParsedKeybinding {
  const raw = input.trim()
  if (!raw) throw new KeybindingSyntaxError('Binding is empty')

  // Multi-step sequences are explicitly out of scope for this PR. Rejecting
  // them is deliberate: accepting `Cmd+K R` and then only ever running the
  // first step would be worse than refusing it, because the Settings row would
  // display a binding the runtime cannot honour.
  if (/\s/.test(raw)) {
    throw new KeybindingSyntaxError(
      `Multi-step sequences are not supported yet (got "${raw}"). Use a single chord.`,
    )
  }

  // WHY a trailing '+' is NOT rescued as a literal key: an earlier version
  // accepted "Cmd++" so a user could bind the plus key. Nothing can ever fire
  // it. Pressing plus on a normal keyboard emits code 'Equal' with shiftKey,
  // which this grammar canonicalizes to 'Cmd+Shift+=' — so "Cmd++" was a
  // binding the Settings UI would happily store and display while the runtime
  // could never match it. That is the same class of defect the multi-step
  // rejection above exists to prevent, so it is rejected the same way.
  const parts = raw.split('+')

  const modifiers: Modifier[] = []
  let key: string | null = null

  for (const part of parts) {
    if (!part) throw new KeybindingSyntaxError(`Malformed binding "${raw}"`)
    const modifier = MODIFIER_ALIASES[part.toLowerCase()]
    if (modifier) {
      if (modifiers.includes(modifier)) {
        throw new KeybindingSyntaxError(`Duplicate modifier "${modifier}" in "${raw}"`)
      }
      modifiers.push(modifier)
      continue
    }
    if (key !== null) {
      throw new KeybindingSyntaxError(`Binding "${raw}" has more than one key`)
    }
    key = canonicalKey(part, raw)
  }

  if (key === null) {
    // A modifier-only binding can never fire as a command chord: the router
    // reads keydown, and a bare modifier keydown has no key to match. Dictation
    // deliberately allows modifier-only holds, which is exactly why the command
    // editor must NOT inherit dictation's capture policy.
    throw new KeybindingSyntaxError(`Binding "${raw}" has no key`)
  }

  return {
    modifiers: MODIFIER_ORDER.filter(m => modifiers.includes(m)),
    key,
  }
}

function canonicalKey(part: string, raw: string): string {
  if (/^[a-zA-Z]$/.test(part)) return part.toUpperCase()
  if (/^[0-9]$/.test(part)) return part
  if (/^[fF](?:[1-9]|1[0-9]|20)$/.test(part)) return `F${part.slice(1)}`
  if (part in PUNCTUATION_CODES) return part

  const named = Object.keys(NAMED_KEYS).find(name => name.toLowerCase() === part.toLowerCase())
  if (named) return named

  // Accept the DOM spelling of arrows too, so a value copied out of devtools
  // or an older config normalizes rather than erroring.
  const domArrow = /^Arrow(Left|Right|Up|Down)$/i.exec(part)
  if (domArrow) return capitalize(domArrow[1])

  throw new KeybindingSyntaxError(`Unrecognized key "${part}" in "${raw}"`)
}

const capitalize = (s: string) => s[0].toUpperCase() + s.slice(1).toLowerCase()

/** Canonical string form. Round-trips: `format(parse(x))` is idempotent. */
export function formatKeybinding(parsed: ParsedKeybinding): Keybinding {
  return [...parsed.modifiers, parsed.key].join('+')
}

/** Parse + reformat in one step, for coercing persisted or authored values. */
export function normalizeKeybinding(input: string): Keybinding {
  return formatKeybinding(parseKeybinding(input))
}

/** Non-throwing variant for coercion paths that must not break settings boot. */
export function tryNormalizeKeybinding(input: unknown): Keybinding | null {
  if (typeof input !== 'string') return null
  try {
    return normalizeKeybinding(input)
  } catch {
    return null
  }
}

/**
 * The canonical binding a keyboard event represents, or null if it is only a
 * modifier press.
 *
 * Reads `event.code` FIRST for letters, digits and punctuation — the whole
 * macOS Option problem — and falls back to `event.key` for named keys, whose
 * `key` value is already stable and whose codes are verbose and layout-tied.
 */
export function keybindingFromEvent(event: KeyboardEvent): Keybinding | null {
  const modifiers: Modifier[] = []
  if (event.metaKey) modifiers.push('Cmd')
  if (event.ctrlKey) modifiers.push('Ctrl')
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')

  const key = keyTokenFromEvent(event)
  if (key === null) return null

  return formatKeybinding({ modifiers: MODIFIER_ORDER.filter(m => modifiers.includes(m)), key })
}

function keyTokenFromEvent(event: KeyboardEvent): string | null {
  const code = event.code

  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1]

  // `Digit1` is the number row; `Numpad1` deliberately does NOT normalize to
  // the same token. They are different physical keys, and collapsing them would
  // make a numpad press fire a binding the user assigned to the number row.
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit) return digit[1]

  const fn = /^F([1-9]|1[0-9]|20)$/.exec(code)
  if (fn) return `F${fn[1]}`

  for (const [name, punctuationCode] of Object.entries(PUNCTUATION_CODES)) {
    if (code === punctuationCode) return name
  }

  // The named-key fallback reads `event.key`, which is where numpad keys leak
  // in: NumpadEnter reports key 'Enter', and Numpad1 with NumLock off reports
  // 'End'. Both would collapse onto the main-keyboard token and fire a binding
  // the user assigned to a different physical key — the exact conflation the
  // Digit/Numpad separation above exists to prevent. Codes are authoritative,
  // so anything explicitly on the numpad is refused before the fallback runs.
  if (code.startsWith('Numpad')) return null

  for (const [name, domKey] of Object.entries(NAMED_KEYS)) {
    if (event.key === domKey) return name
  }

  // A bare modifier keydown. Not an error — the router simply has nothing to
  // match yet, and the user is probably mid-chord.
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) return null

  return null
}

/** Does this event fire the given canonical binding? */
export function eventMatchesKeybinding(event: KeyboardEvent, binding: Keybinding): boolean {
  const eventBinding = keybindingFromEvent(event)
  return eventBinding !== null && eventBinding === binding
}

const DISPLAY_MODIFIERS: Record<Modifier, string> = {
  Cmd: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧',
}

const DISPLAY_KEYS: Record<string, string> = {
  Left: '←', Right: '→', Up: '↑', Down: '↓',
  Enter: '↩', Escape: '⎋', Space: '␣', Tab: '⇥',
  Backspace: '⌫', Delete: '⌦',
}

/**
 * macOS-style display form, e.g. `⌘⇧P`.
 *
 * Presentation ONLY — never persisted, never compared. The audit's whole
 * finding was that a display string had become a second, drifting source of
 * truth; this function must stay a pure projection of the canonical form so
 * that cannot happen again.
 *
 * Modifier symbols are concatenated without separators because that is the
 * platform convention (⌘⇧P, not ⌘+⇧+P), but the KEY keeps a separator when it
 * is a word ("⌥PageUp") so it stays readable.
 */
export function displayKeybinding(binding: Keybinding): string {
  let parsed: ParsedKeybinding
  try {
    parsed = parseKeybinding(binding)
  } catch {
    // A malformed persisted value should render as itself rather than throwing
    // inside a render path and blanking a Settings page.
    return binding
  }
  const modifiers = parsed.modifiers.map(m => DISPLAY_MODIFIERS[m]).join('')
  return `${modifiers}${DISPLAY_KEYS[parsed.key] ?? parsed.key}`
}
