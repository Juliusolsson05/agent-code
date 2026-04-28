export type HeldModifiers = {
  cmd: boolean
  ctrl: boolean
  option: boolean
  shift: boolean
  fn: boolean
}

export const DEFAULT_DICTATION_HOTKEY = 'Fn'

export type KeyboardEventLike = {
  key: string
  code: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

export const EMPTY_MODIFIERS: HeldModifiers = {
  cmd: false,
  ctrl: false,
  option: false,
  shift: false,
  fn: false,
}

const MODIFIER_KEYS = new Set([
  'Meta',
  'Control',
  'Alt',
  'Shift',
  'OS',
  'AltGraph',
  'Fn',
  'FnLock',
  'Hyper',
  'Super',
])

const NAMED_KEYS: Record<string, string> = {
  Space: 'SPACE',
  Tab: 'TAB',
  Enter: 'RETURN',
  NumpadEnter: 'RETURN',
  Backspace: 'BACKSPACE',
  Delete: 'DELETE',
  Escape: 'ESCAPE',
  ArrowUp: 'UP ARROW',
  ArrowDown: 'DOWN ARROW',
  ArrowLeft: 'LEFT ARROW',
  ArrowRight: 'RIGHT ARROW',
  Home: 'HOME',
  End: 'END',
  PageUp: 'PAGE UP',
  PageDown: 'PAGE DOWN',
  Equal: 'EQUALS',
  Minus: 'MINUS',
  BracketLeft: 'BRACKET_LEFT',
  BracketRight: 'BRACKET_RIGHT',
  Semicolon: 'SEMICOLON',
  Quote: 'QUOTE',
  Backslash: 'BACKSLASH',
  Comma: 'COMMA',
  Slash: 'FORWARD SLASH',
  Period: 'DOT',
  Backquote: 'BACKTICK',
}

export function cloneEmptyModifiers(): HeldModifiers {
  return { ...EMPTY_MODIFIERS }
}

export function isModifierKey(event: KeyboardEventLike): boolean {
  return MODIFIER_KEYS.has(event.key)
}

export function updateHeldModifier(
  event: KeyboardEventLike,
  held: HeldModifiers,
  isDown: boolean,
): void {
  if (event.key === 'Meta' || event.code.startsWith('Meta')) held.cmd = isDown
  if (event.key === 'Control' || event.code.startsWith('Control')) held.ctrl = isDown
  if (event.key === 'Alt' || event.code.startsWith('Alt')) held.option = isDown
  if (event.key === 'Shift' || event.code.startsWith('Shift')) held.shift = isDown
  if (event.key === 'Fn' || event.code === 'Fn') held.fn = isDown
}

export function modifierOnlyBinding(held: HeldModifiers): string | null {
  const pressed = modifierParts(held)
  return pressed.length === 1 ? pressed[0] : null
}

export function bindingFromKeyboardEvent(
  event: KeyboardEventLike,
  held: HeldModifiers,
): { binding: string | null; error: string | null } {
  if (isModifierKey(event)) return { binding: null, error: null }

  const modifiers = mergeEventModifierState(event, held)
  const key = normalizeKey(event)
  if (!key) return { binding: null, error: 'That key is not supported yet.' }

  return {
    binding: [...modifierParts(modifiers), key].join('+'),
    error: null,
  }
}

export function formatBindingForDisplay(value: string): string {
  if (!value) return ''
  return value
    .replace(/\bCommandOrControl\b/g, 'Cmd')
    .replace(/\bCommand\b/g, 'Cmd')
    .replace(/\bCmd\b/g, 'Cmd')
    .replace(/\bCtrl\b/g, 'Ctrl')
    .replace(/\bControl\b/g, 'Ctrl')
    .replace(/\bAlt\b/g, 'Option')
    .replace(/\bSPACE\b/g, 'Space')
    .replace(/\bBACKSPACE\b/g, 'Backspace')
    .replace(/\bRETURN\b/g, 'Return')
    .replace(/\bESCAPE\b/g, 'Esc')
    .replace(/\bDOT\b/g, '.')
    .replace(/\bMINUS\b/g, '-')
    .replace(/\bFORWARD SLASH\b/g, '/')
    .replace(/\bBACKSLASH\b/g, '\\')
    .replace(/\bCOMMA\b/g, ',')
    .replace(/\bSEMICOLON\b/g, ';')
    .replace(/\bQUOTE\b/g, "'")
    .replace(/\bBACKTICK\b/g, '`')
    .replace(/\+/g, ' + ')
}

export function keyboardEventMatchesBinding(
  event: KeyboardEventLike,
  binding: string,
): boolean {
  const normalized = binding.trim()
  if (!normalized) return false

  const held: HeldModifiers = {
    cmd: Boolean(event.metaKey),
    ctrl: Boolean(event.ctrlKey),
    option: Boolean(event.altKey),
    shift: Boolean(event.shiftKey),
    fn: event.key === 'Fn' || event.code === 'Fn',
  }

  if (isModifierKey(event)) return modifierOnlyBinding(held) === normalized

  const key = normalizeKey(event)
  if (!key) return false
  return [...modifierParts(held), key].join('+') === normalized
}

export function coerceHotkeyBinding(value: unknown): string {
  if (value === 'mod-shift-d') return 'Cmd+Shift+D'
  if (value === 'mod-shift-v') return 'Cmd+Shift+V'
  if (value === 'off') return ''
  if (typeof value !== 'string') return DEFAULT_DICTATION_HOTKEY
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : ''
}

function mergeEventModifierState(event: KeyboardEventLike, held: HeldModifiers): HeldModifiers {
  return {
    cmd: held.cmd || Boolean(event.metaKey),
    ctrl: held.ctrl || Boolean(event.ctrlKey),
    option: held.option || Boolean(event.altKey),
    shift: held.shift || Boolean(event.shiftKey),
    fn: held.fn,
  }
}

function modifierParts(held: HeldModifiers): string[] {
  const parts: string[] = []
  if (held.cmd) parts.push('Cmd')
  if (held.ctrl) parts.push('Ctrl')
  if (held.option) parts.push('Option')
  if (held.shift) parts.push('Shift')
  if (held.fn) parts.push('Fn')
  return parts
}

function normalizeKey(event: KeyboardEventLike): string | null {
  if (event.code.startsWith('Key')) return event.code.slice(3)
  if (event.code.startsWith('Digit')) return event.code.slice(5)
  if (/^F\d{1,2}$/.test(event.code)) return event.code
  if (NAMED_KEYS[event.code]) return NAMED_KEYS[event.code]
  return event.code || null
}
