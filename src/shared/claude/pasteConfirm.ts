// Claude paste-commit detection — THE ONE implementation, shared by both the
// desktop composer (renderer: claudePaste.ts) and the remote/runtime delivery
// path (main: providers/claude/runtime/promptDelivery.ts).
//
// WHY this module exists (the bug it kills):
//   Claude's TUI buffers bracketed-paste bytes on a ~100ms accumulator; an
//   Enter that lands inside that window is swallowed as more paste content
//   instead of submitting — the prompt just sits in the composer. The fix is
//   to send `\r` only AFTER the composer has visibly committed the paste. But
//   Claude reflects a committed paste TWO ways, and which one depends on size:
//     * COLLAPSE — big pastes become a `[Pasted text #N]` placeholder.
//       (measured: single-line >~800 chars, or multiline >=~4 lines)
//     * INLINE   — everything smaller is inserted as raw text; NO placeholder
//       ever renders. This is the band that includes short multi-line prompts
//       and — critically — EVERY dictated prompt, because the <stt>…</stt>
//       wrapper adds newlines and thus always takes the paste route.
//
//   The desktop composer already detected BOTH (placeholder OR inline tail).
//   The runtime delivery path only ever watched for the placeholder, so every
//   inlined paste timed out unconfirmed ("did not confirm pasted prompt before
//   submit") and stuck in the composer — the never-ending remote/mobile "send
//   doesn't work" bug. The two paths had drifted; the robust detector lived in
//   the renderer and was never ported. Making it shared makes that drift
//   impossible: fix it here, both paths get it.
//
//   Characterized empirically against a real `claude` PTY — see the harness in
//   tmp/paste-repro/ (matrix/sweep). The inline tail appears in ~10–30ms for
//   every dead-zone case, so this is fast and load-independent.

/**
 * Below this length (and with no newline) Claude's paste ACCUMULATOR never
 * engages, so a plain `text + \r` in one write is safe and needs no
 * confirmation. Above it, OR with any newline, the paste route + this
 * detection is mandatory. Empirical lower bound; single source for every
 * `isPasteLike` check (previously duplicated in claudePaste.ts,
 * composerSubmit.ts, useComposerKeybinds.ts, and promptDelivery.ts).
 */
export const CLAUDE_PASTE_THRESHOLD = 100

/** The routing predicate: does this text need the bracketed-paste + confirm
 *  protocol, or can it take the plain `text\r` fast path? */
export function isPasteLike(text: string): boolean {
  return text.includes('\n') || text.length > CLAUDE_PASTE_THRESHOLD
}

const PASTE_PLACEHOLDER_RE = /\[Pasted text #\d+/g

/**
 * Return only Claude's currently active composer region.
 *
 * WHY the whole screen is unsafe: `recent` intentionally includes scrollback,
 * so a previous user message can contain the same tail (or an old paste
 * placeholder) forever. Delivery confirmation is about a transition in the
 * editable composer, not whether the bytes appeared anywhere in terminal
 * history. Claude marks that region with the final `❯` prompt and closes it at
 * the horizontal status separator. Falling back to the final viewport lines
 * preserves compatibility with startup variants that have not drawn `❯` yet,
 * while still refusing to search an unbounded transcript.
 */
export function extractActiveClaudeComposer(screen: string): string {
  const lines = screen.split('\n')
  let start = -1
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^\s*❯(?:\s|$)/u.test(lines[i] ?? '')) {
      start = i
      break
    }
  }
  if (start < 0) return lines.slice(-12).join('\n')

  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*[─━-]{8,}/u.test(lines[i] ?? '')) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

export function placeholderCount(screen: string): number {
  const matches = screen.match(PASTE_PLACEHOLDER_RE)
  return matches ? matches.length : 0
}

export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ')
}

/**
 * A distinctive needle from the END of the paste. The paste's tail lands at
 * the composer cursor, so it's the most reliable contiguous substring to find
 * when Claude inlines a paste (no placeholder). Whitespace-normalized so the
 * TUI's reflow/wrapping doesn't defeat the match. Null for pastes too short to
 * fingerprint — those take the plain `text + \r` route and never reach here.
 */
export function pasteTailNeedle(payload: string): string | null {
  const norm = normalizeWhitespace(payload).trim()
  return norm.length >= 8 ? norm.slice(-24) : null
}

export type PasteAbsorbedOutcome =
  | { kind: 'absorbed'; waitedMs: number; via: 'placeholder' | 'inline' }
  | { kind: 'timeout' }

/**
 * Pure transition check. Given the screen captured BEFORE the paste
 * (baseline, via `baseCount`/`tailAlreadyPresent`) and the current screen, has
 * THIS paste visibly committed yet?
 *
 * The baseline comparison is load-bearing for a SECOND paste in the same
 * session: after paste #1 collapses, a stale `[Pasted text #1]` stays on
 * screen. A naive "any placeholder present?" check (which the old runtime
 * probe used) would false-confirm paste #2 instantly on that stale
 * placeholder and fire `\r` before #2 committed. Requiring a count INCREASE
 * (and a NEWLY-appearing tail) makes the detector immune to it.
 */
export function pasteAbsorbedVia(
  screen: string,
  tail: string | null,
  baseCount: number,
  tailAlreadyPresent: boolean,
): 'placeholder' | 'inline' | null {
  if (placeholderCount(screen) > baseCount) return 'placeholder'
  if (tail && !tailAlreadyPresent && normalizeWhitespace(screen).includes(tail)) return 'inline'
  return null
}

/**
 * Poll a live screen getter until the paste is absorbed (placeholder OR inline
 * tail) or the timeout fires. `baselineScreen` MUST be captured BEFORE the
 * bracketed paste is written so both signals detect a TRANSITION rather than
 * coincidental pre-existing content (and so paste #2 ignores paste #1's stale
 * placeholder — see `pasteAbsorbedVia`).
 *
 * `getScreen` may return undefined (the renderer's snapshot ref before the
 * first screen event); treated as an empty screen.
 */
export function pollPasteAbsorbed(
  getScreen: () => string | undefined,
  baselineScreen: string,
  payload: string,
  opts: { timeoutMs: number; pollIntervalMs: number },
): Promise<PasteAbsorbedOutcome> {
  const tail = pasteTailNeedle(payload)
  const baselineComposer = extractActiveClaudeComposer(baselineScreen)
  const baseCount = placeholderCount(baselineComposer)
  const tailAlreadyPresent = tail
    ? normalizeWhitespace(baselineComposer).includes(tail)
    : false
  const startedAt = Date.now()
  return new Promise(resolve => {
    const tick = (): void => {
      const composer = extractActiveClaudeComposer(getScreen() ?? '')
      const via = pasteAbsorbedVia(composer, tail, baseCount, tailAlreadyPresent)
      if (via) {
        resolve({ kind: 'absorbed', waitedMs: Date.now() - startedAt, via })
        return
      }
      if (Date.now() - startedAt >= opts.timeoutMs) {
        resolve({ kind: 'timeout' })
        return
      }
      setTimeout(tick, opts.pollIntervalMs)
    }
    tick()
  })
}
