import { globalShortcut } from 'electron'

import { sendToFocusedWindow } from '@main/window/windowRegistry.js'
import { startMacDictationHotkeyHelper, stopMacDictationHotkeyHelper } from '@main/dictation/macHotkeyHelper.js'

let currentBinding = ''
let registeredElectronHotkey = ''
let electronHotkeyRecording = false

// WHY every edge here goes to the FOCUSED window rather than a fixed one:
// the dictation hotkey is a global accelerator, so it fires no matter which
// window the user is in — and with several windows open, "start listening" can
// only sensibly mean the composer they are looking at. `sendToFocusedWindow`
// falls back to the most recently focused window, which matters because a
// global shortcut can arrive while Agent Code is not even frontmost, and
// `BrowserWindow.getFocusedWindow()` returns null in exactly that case.
//
// Down and up edges are NOT re-resolved independently: see the release note on
// `releaseElectronHotkeyRecording`.

/**
 * Electron exposes an accelerator activation callback, not a physical key-up
 * callback. Pretending one activation was both down and up made every quiet
 * accelerator look like a zero-millisecond hold, which the renderer correctly
 * discards as an accidental tap. The quiet path is therefore intentionally a
 * toggle: first activation starts, second activation stops. The CGEventTap path
 * below still has real edges and remains hold-to-talk.
 *
 * This helper also gives reconfiguration one drain point. If the user changes
 * or disables the binding while a toggle recording is live, emitting the old
 * binding's up edge before unregistering prevents an orphan recording from
 * listening forever.
 */
function releaseElectronHotkeyRecording(binding: string): void {
  if (!electronHotkeyRecording) return
  electronHotkeyRecording = false
  sendToFocusedWindow('dictation:hotkey-up', { binding })
}

// WHY a binding-classifier lives here (packaged-app fix):
//
// The original macOS flow routed every dictation binding through the
// CGEventTap helper — that gave one uniform press/release model for Fn,
// bare modifiers, right-mods, and normal chords. But CGEventTap requires
// the Accessibility permission, which shows a scary system prompt every
// time an unsigned build launches (see #495 A4 + Wispr Flow docs). Users
// who never enable dictation still saw the prompt.
//
// Split: any accelerator that Electron's `globalShortcut` can register
// natively (a chord like "Cmd+Shift+D" — one non-modifier key with
// modifiers) goes through `globalShortcut` — zero OS prompt. Everything
// left over (bare "Fn", bare modifiers, right-hand modifiers, any binding
// mentioning Fn) still needs the CGEventTap helper because Chromium does
// not expose those to renderer keydown reliably. Users choosing Fn get an
// upfront "requires Accessibility permission" warning in the settings row
// instead of a first-launch surprise prompt.
//
// The mapping from this repo's binding vocabulary ("Cmd+Shift+D",
// "SPACE") to Electron's accelerator vocabulary ("Cmd+Shift+D", "Space")
// lives in `toElectronAccelerator` below. See src/renderer/src/lib/
// hotkeyBinding.ts for the source vocabulary and the tests around it.
const ACCELERATOR_MODIFIERS = new Set(['Cmd', 'Ctrl', 'Option', 'Shift'])
const NAMED_KEY_TO_ACCELERATOR: Record<string, string> = {
  SPACE: 'Space',
  TAB: 'Tab',
  RETURN: 'Return',
  BACKSPACE: 'Backspace',
  DELETE: 'Delete',
  ESCAPE: 'Escape',
  'UP ARROW': 'Up',
  'DOWN ARROW': 'Down',
  'LEFT ARROW': 'Left',
  'RIGHT ARROW': 'Right',
  HOME: 'Home',
  END: 'End',
  'PAGE UP': 'PageUp',
  'PAGE DOWN': 'PageDown',
  EQUALS: 'Plus', // Electron's accelerator name for `=`
  MINUS: '-',
  BRACKET_LEFT: '[',
  BRACKET_RIGHT: ']',
  SEMICOLON: ';',
  QUOTE: "'",
  BACKSLASH: '\\',
  COMMA: ',',
  'FORWARD SLASH': '/',
  DOT: '.',
  BACKTICK: '`',
}

type AcceleratorClassification =
  | { kind: 'electron'; accelerator: string }
  | { kind: 'native'; reason: 'contains-fn' | 'modifier-only' | 'unknown-key' }

/** Route bindings that Electron's globalShortcut can handle to that
 *  quiet path; anything Fn-shaped or modifier-only must still go through
 *  the CGEventTap helper (Accessibility-gated). Exported for test-only
 *  coverage from the vitest hotkey suite. */
export function classifyDictationBinding(binding: string): AcceleratorClassification {
  const parts = binding.split('+').map(p => p.trim()).filter(Boolean)
  if (parts.length === 0) {
    return { kind: 'native', reason: 'modifier-only' }
  }
  if (parts.some(p => p === 'Fn')) {
    return { kind: 'native', reason: 'contains-fn' }
  }
  const keyToken = parts[parts.length - 1]
  const modifierTokens = parts.slice(0, -1)
  // A binding whose last token is itself a modifier (e.g. "Cmd") is a
  // bare-modifier trigger — Electron's globalShortcut refuses those.
  if (ACCELERATOR_MODIFIERS.has(keyToken) && modifierTokens.length === 0) {
    return { kind: 'native', reason: 'modifier-only' }
  }
  const translatedKey =
    NAMED_KEY_TO_ACCELERATOR[keyToken] ??
    (/^F\d{1,2}$/.test(keyToken) ? keyToken : keyToken.length === 1 ? keyToken.toUpperCase() : null)
  if (!translatedKey) {
    return { kind: 'native', reason: 'unknown-key' }
  }
  const acceleratorParts: string[] = []
  for (const mod of modifierTokens) {
    if (mod === 'Cmd') acceleratorParts.push('Cmd')
    else if (mod === 'Ctrl') acceleratorParts.push('Ctrl')
    else if (mod === 'Option') acceleratorParts.push('Alt')
    else if (mod === 'Shift') acceleratorParts.push('Shift')
    else return { kind: 'native', reason: 'unknown-key' }
  }
  acceleratorParts.push(translatedKey)
  return { kind: 'electron', accelerator: acceleratorParts.join('+') }
}

export async function configureDictationHotkey(binding: string): Promise<{
  ok: boolean
  binding: string
  native: boolean
  /** Failure reason from the native-helper layer (#495 A4) — e.g. "Xcode
   *  Command Line Tools not installed" in dev, or "bundled helper binary
   *  missing" in a packaged build. Rides the existing
   *  DictationHotkeyConfigureResult ok:false arm; absent on success. */
  message?: string
}> {
  const previousBinding = currentBinding
  releaseElectronHotkeyRecording(previousBinding)
  currentBinding = binding.trim()
  if (registeredElectronHotkey) {
    globalShortcut.unregister(registeredElectronHotkey)
    registeredElectronHotkey = ''
  }
  stopMacDictationHotkeyHelper()

  if (!currentBinding) return { ok: true, binding: currentBinding, native: false }

  const classification = classifyDictationBinding(currentBinding)

  if (classification.kind === 'electron') {
    // Electron-quiet path — works on every platform, needs no Accessibility
    // prompt. globalShortcut has no release callback, so this path is a toggle
    // rather than fake hold-to-talk: first activation starts and the next one
    // stops. Synthesizing down+up in one callback is not a harmless shortcut —
    // useComposerDictation deliberately discards sub-180 ms taps.
    try {
      const ok = globalShortcut.register(classification.accelerator, () => {
        if (electronHotkeyRecording) {
          releaseElectronHotkeyRecording(currentBinding)
          return
        }
        electronHotkeyRecording = true
        sendToFocusedWindow('dictation:hotkey-down', { binding: currentBinding })
      })
      if (ok) registeredElectronHotkey = classification.accelerator
      return { ok, binding: currentBinding, native: false }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[dictation:hotkey] invalid Electron accelerator "${classification.accelerator}"`,
        err,
      )
      return {
        ok: false,
        binding: currentBinding,
        native: false,
        message: err instanceof Error ? err.message : 'Invalid keyboard shortcut.',
      }
    }
  }

  if (process.platform === 'darwin') {
    // CGEventTap helper path (Accessibility-gated). Only used for bindings
    // Electron cannot register: bare Fn, bare modifiers, or unknown named
    // keys. The renderer settings row already gates Fn choices behind an
    // explicit "requires Accessibility permission" warning, so we never
    // reach this path on first launch with the shipped defaults.
    const result = await startMacDictationHotkeyHelper(currentBinding, {
      onPress: () => {
        // Press/release bugs are catastrophic for hold-to-talk: one missed
        // release leaves the composer "listening" forever. Keep this trace in
        // main so we can distinguish native-helper problems from renderer
        // lifecycle problems without guessing from Deepgram logs.
        // eslint-disable-next-line no-console
        console.debug('[dictation:hotkey] down', { binding: currentBinding, at: Date.now() })
        sendToFocusedWindow('dictation:hotkey-down', { binding: currentBinding })
      },
      onRelease: () => {
        // eslint-disable-next-line no-console
        console.debug('[dictation:hotkey] up', { binding: currentBinding, at: Date.now() })
        sendToFocusedWindow('dictation:hotkey-up', { binding: currentBinding })
      },
    })
    return {
      ok: result.ok,
      binding: currentBinding,
      native: true,
      ...(result.message ? { message: result.message } : {}),
    }
  }

  // Non-macOS and classification is 'native' — nothing we can do.
  return {
    ok: false,
    binding: currentBinding,
    native: false,
    message: 'This shortcut requires macOS-specific key detection.',
  }
}

export function unregisterDictationHotkey(): void {
  releaseElectronHotkeyRecording(currentBinding)
  currentBinding = ''
  if (registeredElectronHotkey) {
    globalShortcut.unregister(registeredElectronHotkey)
    registeredElectronHotkey = ''
  }
  stopMacDictationHotkeyHelper()
}
