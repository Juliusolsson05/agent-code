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
  return /[\r\n]/.test(text) || text.length > CLAUDE_PASTE_THRESHOLD
}

// Both are matched against WHITESPACE-NORMALIZED text, never the raw screen —
// see `placeholderCount` / `imagePlaceholderCount` for why.
//
// `\s+` rather than a literal space is cosmetic, not load-bearing: after
// `normalizeWhitespace` no run of whitespace longer than one character can
// exist, so the two are provably equivalent here (review R1-F2 corrected an
// earlier comment claiming it caught "an odd gap that survives
// normalization" — nothing does). It is kept because it states the intent at
// the point of use.
//
// No closing bracket on the paste one, on purpose: Claude appends a size to
// the collapsed form (`[Pasted text #1 +42 lines]`), so the index is where a
// reliable match ends. The image one keeps both brackets and the index, so a
// bare `[Image` in prompt content is never mistaken for a rendered attachment.
const PASTE_PLACEHOLDER_RE = /\[Pasted\s+text\s+#\d+/g
const IMAGE_PLACEHOLDER_RE = /\[Image\s+#\d+\]/g

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
  return locateActiveClaudeComposer(screen).lines.join('\n')
}

/** The composer's physical lines, plus the width of the chrome divider right
 *  above it when there is one (Claude draws that divider across the full
 *  composer width, so it is the width a hard wrap fills). */
function locateActiveClaudeComposer(screen: string): { lines: string[]; width: number | null } {
  const lines = screen.split('\n')
  const isDivider = (line: string): boolean => {
    // Keep this aligned with claude-code-headless ScreenParser's proven chrome
    // predicate. ASCII Markdown rules are user content, not Claude chrome.
    const dividerChars = (line.match(/[─━═▔]/gu) ?? []).length
    const nonSpace = line.replace(/\s/gu, '').length
    return dividerChars >= 10 && dividerChars >= nonSpace * 0.8
  }
  let start = -1
  let width: number | null = null
  // Normal Claude geometry has a chrome divider immediately before the input
  // box. Within that bounded segment choose the FIRST ❯: later `❯ quoted`
  // lines can be literal pasted content and must not rebase the composer.
  for (let divider = lines.length - 1; divider >= 0; divider -= 1) {
    if (!isDivider(lines[divider] ?? '')) continue
    const nextDivider = lines.findIndex((line, i) => i > divider && isDivider(line))
    const segmentEnd = nextDivider < 0 ? lines.length : nextDivider
    for (let i = divider + 1; i < segmentEnd; i += 1) {
      if (/^\s*❯(?:\s|$)/u.test(lines[i] ?? '')) {
        start = i
        width = (lines[divider] ?? '').trimEnd().length
        break
      }
    }
    if (start >= 0) break
  }
  // Sanitized/unit screens and older Claude layouts may omit the upper chrome
  // divider. Preserve the old fallback there, bounded to the viewport tail.
  if (start < 0) {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (/^\s*❯(?:\s|$)/u.test(lines[i] ?? '')) {
        start = i
        break
      }
    }
  }
  if (start < 0) return { lines: lines.slice(-12), width: null }

  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (isDivider(lines[i] ?? '')) {
      end = i
      break
    }
  }
  return { lines: lines.slice(start, end), width }
}

/**
 * The text Claude's composer actually holds, with the TUI's line wrapping
 * undone. This is what the inline-tail check compares against (#1118).
 *
 * WHY the wrapping has to be undone rather than tolerated: Claude's Ink wraps
 * with `hard: true` (vendor/claude-code-src/full/ink/wrap-text.ts). A SOFT wrap
 * breaks at a space; a HARD wrap cuts a token longer than the line in the
 * middle, onto a continuation line with a two-space indent. Collapsing
 * whitespace turned a hard cut into a space the payload never had, so a
 * prompt ending in a long path was never seen as absorbed and rolled back.
 *
 * Two earlier fixes were withdrawn in review, and why is the point:
 *  - stripping ALL whitespace also accepted MISSING whitespace (`foo\nbar`
 *    matched a composer showing `foobar`), which sent Enter for pastes that
 *    had not landed;
 *  - a pattern allowing optional whitespace between any two characters
 *    matched an EARLIER part of the same paste that had a real space where
 *    the tail has none, again sending Enter before the tail arrived.
 * Both guessed where a wrap might be. This reconstructs where it IS.
 *
 * The rule: a line that fills the whole composer width (one column less than
 * the divider) and whose continuation does not start with a space was cut
 * mid-token, so the two join
 * with nothing between them. Every other line break was a soft wrap at a space
 * and joins with one space. When the width is unknown (no divider on screen)
 * every break is treated as soft, which is the old behaviour. Misreading a
 * rare exactly-full soft line errs toward a TIMEOUT (a missed confirmation),
 * never toward an early Enter.
 */
export function activeClaudeComposerText(screen: string): string {
  const { lines, width } = locateActiveClaudeComposer(screen)
  let text = ''
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (i === 0) {
      text = line
      continue
    }
    // Continuation lines carry a two-space indent; anything after it is text.
    const content = line.startsWith('  ') ? line.slice(2) : line.trimStart()
    const previous = (lines[i - 1] ?? '').trimEnd()
    // A full composer line is ONE column shorter than the divider: Claude keeps
    // the last column free (calibrated on the recorded 64-column frames, body
    // 61 + the two-column prefix = 63). Comparing against the divider width
    // itself never fired on a real screen (#1219 review, Pi F3).
    const hardCut = width !== null && previous.length >= width - 1 && content.length > 0 && !/^\s/u.test(content)
    text = hardCut ? text.trimEnd() + content : `${text} ${content}`
  }
  return text
}

/**
 * How many collapsed-paste placeholders the given composer text holds.
 *
 * Normalized for the same reason as `imagePlaceholderCount` (#1113), and this
 * one is worse: `[Pasted text #1]` has TWO internal spaces, so there are two
 * columns at which a soft wrap can hide it. Unlike the image case this was not
 * caught in a recording — it is fixed by analogy, because the failure mode is
 * strictly nastier. When a COLLAPSED paste's placeholder goes unseen there is
 * no second signal to fall back on: `pasteAbsorbedVia` then looks for the
 * paste's tail inline, and a paste Claude collapsed has no tail on screen to
 * find. Text delivery would hit its whole 5 s budget and strand the draft in
 * the composer, exactly as the image path did.
 *
 * This is a FIX, not a precaution, and an earlier comment here got that
 * backwards (review R1-F1/R2-F1). Before #1113 `pasteAbsorbedVia` matched this
 * counter against the RAW screen — only its inline-tail branch normalized — so
 * a wrapped placeholder was missed on the text path exactly as it was on the
 * image path. What was true is narrower: INLINED pastes were immune, because
 * the tail branch normalized. Collapsed ones never were.
 */
export function placeholderCount(screen: string): number {
  const matches = normalizeWhitespace(screen).match(PASTE_PLACEHOLDER_RE)
  return matches ? matches.length : 0
}

/**
 * How many rendered image attachments the given composer text holds.
 *
 * WHY the screen is normalized first (#1113): `[Image #1]` contains exactly one
 * space, and that space is the only place a SOFT wrap can break it — so
 * whenever the pill lands on the wrap column the TUI renders it as `[Image` /
 * `  #1]` across two lines.
 *
 * The bound on that claim, since it is the load-bearing premise (review
 * R1-F4/R2-F1): Claude's Ink wraps with `hard: true`
 * (vendor/claude-code-src/full/ink/wrap-text.ts), so a token LONGER than the
 * pane is broken mid-token, and normalization cannot repair that — it turns the
 * break into a space. For this pill that needs a composer under ~11 columns,
 * which is why it holds in practice. It does NOT hold for the inline tail
 * needle, whose payload routinely contains long paths; that is a separate,
 * pre-existing defect tracked in #1118 rather than something this normalization
 * fixes. Matching the raw text found neither half, the count never rose
 * above its baseline, and `pollClaudeImagesAbsorbed` burned its whole 5 s
 * budget before returning `absorption-timeout` with `retrySafe: false`. The
 * user then saw "the prompt was never submitted" for a prompt sitting complete
 * in Claude's composer, and had to clear it by hand. Recorded in
 * testing/fixtures/image-absorption/, where the same pane at the same width
 * failed one send and passed the next purely on where that space fell.
 *
 * WHY normalization is safe here rather than merely convenient: this count is
 * only ever consumed as a DELTA against a baseline computed by this same
 * function, so collapsing whitespace cannot manufacture a transition — it can
 * only stop the detector from missing one. It also CLOSES a hole rather than
 * opening one: a wrapped pill previously counted 0 at baseline, so a later
 * unwrapped pill could confirm on a 0→1 delta that was not a transition at all.
 *
 * What the delta argument does NOT cover, because it is a different axis
 * (review R2-F4): for a short, non-paste-like prompt `deliverClaudeImagePrompt`
 * takes the image baseline immediately after writing the text, before the text
 * has repainted. A prompt whose own TEXT contains `[Image #N]` then counts 1
 * the moment it paints, and absorption confirms before any attachment exists.
 * That predates this change, which widens it only in that a wrapped literal now
 * counts too. Tracked in #1119.
 */
export function imagePlaceholderCount(screen: string): number {
  return normalizeWhitespace(screen).match(IMAGE_PLACEHOLDER_RE)?.length ?? 0
}

export async function pollClaudeImagesAbsorbed(
  getScreen: () => string | undefined,
  baselineScreen: string,
  expectedIncrease: number,
  opts: { timeoutMs: number; pollIntervalMs: number },
): Promise<PasteAbsorbedOutcome> {
  const baseline = imagePlaceholderCount(extractActiveClaudeComposer(baselineScreen))
  const startedAt = Date.now()
  return new Promise(resolve => {
    const tick = (): void => {
      const current = imagePlaceholderCount(
        extractActiveClaudeComposer(getScreen() ?? ''),
      )
      if (current >= baseline + expectedIncrease) {
        resolve({ kind: 'absorbed', waitedMs: Date.now() - startedAt, via: 'placeholder' })
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

export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ')
}

/**
 * A distinctive needle from the END of the paste. The paste's tail lands at
 * the composer cursor, so it's the most reliable contiguous substring to find
 * when Claude inlines a paste (no placeholder). Whitespace-normalized, and
 * compared against `activeClaudeComposerText`, which has the TUI's wrapping
 * undone, so neither a soft nor a hard wrap defeats the match. Short prompts
 * use their full normalized value. They used to bypass this detector through
 * an unsafe atomic `text + \r` write; now even a one-character prompt must
 * visibly enter the active composer before Enter is allowed to follow.
 */
export function pasteTailNeedle(payload: string): string | null {
  const norm = normalizeWhitespace(payload).trim()
  return norm.length > 0 ? norm.slice(-24) : null
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
  // The unwrapped composer text (see `activeClaudeComposerText`), for both the
  // baseline and every poll, so a hard-wrapped tail is found and a tail that
  // was already there is recognised as such.
  const baselineComposer = activeClaudeComposerText(baselineScreen)
  const baseCount = placeholderCount(baselineComposer)
  const tailAlreadyPresent = tail
    ? normalizeWhitespace(baselineComposer).includes(tail)
    : false
  const startedAt = Date.now()
  return new Promise(resolve => {
    const tick = (): void => {
      const composer = activeClaudeComposerText(getScreen() ?? '')
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
