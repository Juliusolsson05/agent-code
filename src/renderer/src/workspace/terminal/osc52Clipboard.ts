import type { Terminal } from '@xterm/xterm'

/**
 * Write-only OSC 52 clipboard handler for xterm.js panes.
 *
 * WHY this exists (#1551):
 * Agent Code enables `tmux mouse on` so trackpad scrolling works naturally in
 * Terminal-default panes. Under tmux mouse mode, dragging to select text
 * triggers tmux's copy-mode, which copies to the host clipboard by emitting an
 * OSC 52 escape sequence (`\x1b]52;<selection>;<base64>\x07`). Without an
 * xterm OSC 52 handler, xterm silently drops the sequence and mouse-drag copy
 * never reaches the macOS clipboard.
 *
 * WHY write-only (ignoring `?` read queries):
 * OSC 52 also defines a clipboard-read query (`\x1b]52;c;?\x07`) where a
 * terminal replies with the user's current clipboard contents. Answering read
 * queries would let any untrusted process or remote SSH session running inside
 * a pane silently exfiltrate passwords or secrets from the macOS clipboard.
 * Returning `true` on `?` consumes the query cleanly without touching the
 * clipboard or replying to the PTY.
 *
 * WHY a 1 MiB cap:
 * A runaway or malicious escape sequence carrying tens of megabytes of base64
 * would stall the renderer during `atob` / UTF-8 decoding. 1 MiB covers every
 * realistic terminal selection while keeping decoding bounded.
 */

const MAX_OSC52_DECODED_BYTES = 1024 * 1024
// Base64 expands 3 bytes into 4 chars; add a small slack for optional padding
// and line-wrapping before rejecting without decoding.
const MAX_OSC52_BASE64_CHARS = Math.ceil((MAX_OSC52_DECODED_BYTES * 4) / 3) + 64
// Guard the raw string BEFORE regex whitespace stripping so an adversarial
// multi-megabyte whitespace-padded sequence is rejected in O(1) without
// allocating a stripped copy.
const MAX_OSC52_RAW_PAYLOAD_CHARS = MAX_OSC52_BASE64_CHARS * 2

type Disposable = { dispose(): void }

/**
 * Parses an xterm OSC 52 payload (`<selection>;<base64>`) into UTF-8 text.
 * Returns `null` for clipboard read queries (`?`), malformed parameters,
 * oversized payloads, or invalid base64.
 */
export function parseOsc52ClipboardWrite(data: string): string | null {
  const separator = data.indexOf(';')
  if (separator === -1) return null

  const payload = data.slice(separator + 1)
  // Ignore clipboard read queries (`?`) for security — never expose host
  // clipboard contents back to the PTY.
  if (payload === '?' || payload.length === 0 || payload.length > MAX_OSC52_RAW_PAYLOAD_CHARS) {
    return null
  }

  // Strip ASCII whitespace that some multiplexers insert when wrapping long
  // base64 payloads, then enforce the size cap before allocating a decoded
  // buffer.
  const compact = payload.replace(/\s+/g, '')
  if (compact.length === 0 || compact.length > MAX_OSC52_BASE64_CHARS) return null

  try {
    const binary = atob(compact)
    if (binary.length > MAX_OSC52_DECODED_BYTES) return null
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i)
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * Registers a write-only OSC 52 clipboard handler on an xterm.js `Terminal`.
 *
 * Tolerates minimal test doubles that omit `term.parser` so unrelated leaf
 * tests do not need to mock xterm's parser internals.
 */
export function attachOsc52ClipboardHandler(
  term: Pick<Terminal, 'parser'>,
  writeClipboard: (text: string) => Promise<void> | void = text =>
    navigator.clipboard?.writeText(text),
): Disposable {
  if (!term.parser || typeof term.parser.registerOscHandler !== 'function') {
    return { dispose() {} }
  }

  return term.parser.registerOscHandler(52, data => {
    const text = parseOsc52ClipboardWrite(data)
    if (text === null) return true
    try {
      void Promise.resolve(writeClipboard(text)).catch(() => undefined)
    } catch {
      // Clipboard writes can be rejected in unfocused or headless contexts;
      // swallow so an OSC 52 sequence never surfaces as an uncaught error.
    }
    return true
  })
}
