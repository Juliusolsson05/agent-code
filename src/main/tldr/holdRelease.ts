import { spawn } from 'node:child_process'

// DOM code is a physical key, unlike event.key on Option/non-US layouts.
// These are Apple's virtual key codes (the helper does no layout translation).
const macKeyCodes: Record<string, number> = {
  KeyA: 0x00, KeyS: 0x01, KeyD: 0x02, KeyF: 0x03, KeyH: 0x04, KeyG: 0x05,
  KeyZ: 0x06, KeyX: 0x07, KeyC: 0x08, KeyV: 0x09, KeyB: 0x0b,
  KeyQ: 0x0c, KeyW: 0x0d, KeyE: 0x0e, KeyR: 0x0f, KeyY: 0x10, KeyT: 0x11,
  Digit1: 0x12, Digit2: 0x13, Digit3: 0x14, Digit4: 0x15, Digit6: 0x16,
  Digit5: 0x17, Equal: 0x18, Digit9: 0x19, Digit7: 0x1a, Minus: 0x1b,
  Digit8: 0x1c, Digit0: 0x1d, BracketRight: 0x1e, KeyO: 0x1f,
  KeyU: 0x20, BracketLeft: 0x21, KeyI: 0x22, KeyP: 0x23,
  Enter: 0x24, KeyL: 0x25, KeyJ: 0x26, Quote: 0x27, KeyK: 0x28,
  Semicolon: 0x29, Backslash: 0x2a, Comma: 0x2b, Slash: 0x2c,
  KeyN: 0x2d, KeyM: 0x2e, Period: 0x2f, Tab: 0x30, Space: 0x31,
  Backquote: 0x32, Backspace: 0x33, Escape: 0x35, Delete: 0x75,
  Home: 0x73, End: 0x77, PageUp: 0x74, PageDown: 0x79,
  ArrowLeft: 0x7b, ArrowRight: 0x7c, ArrowDown: 0x7d, ArrowUp: 0x7e,
  F1: 0x7a, F2: 0x78, F3: 0x63, F4: 0x76, F5: 0x60, F6: 0x61,
  F7: 0x62, F8: 0x64, F9: 0x65, F10: 0x6d, F11: 0x67, F12: 0x6f,
}

/** The observer cannot activate a preview. It can only end a renderer-owned
 * hold, and returns a cancellation function synchronously, even while the dev
 * helper is compiling. This prevents an old async start from surviving blur,
 * navigation, or a second gesture. The packaged binary is built ahead of time. */
export function watchMacTldrRelease(
  binary: Promise<string>, code: string, release: () => void,
  start = (file: string, args: string[]) => spawn(file, args, { stdio: 'ignore' }),
): () => void {
  let cancelled = false
  let child: ReturnType<typeof start> | undefined
  const keyCode = macKeyCodes[code]
  void binary.then(file => {
    if (cancelled) return
    if (keyCode === undefined) { release(); return }
    child = start(file, ['--watch-release', String(keyCode)])
    // Exiting because the key is up and failing to observe it both dismiss the
    // hold. Never leave an opaque overlay stuck on a helper/packaging failure.
    const ended = () => { if (!cancelled) { cancelled = true; release() } }
    child.once('exit', ended)
    child.once('error', ended)
  }).catch(() => { if (!cancelled) { cancelled = true; release() } })
  return () => { cancelled = true; child?.kill() }
}
