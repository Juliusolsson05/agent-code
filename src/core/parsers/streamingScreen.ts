// The screen buffer we receive from the headless terminal contains CC's
// full Ink UI: the previous user message, the assistant's in-progress
// response, and a bordered input box at the bottom. For the streaming
// card we want only the middle (the in-progress response), so we strip
// the obvious chrome.
//
// This is a heuristic — CC's TUI layout can change between releases and
// any chrome we don't recognize will leak through. The fix isn't to make
// this regex bulletproof; it's to keep this function pure and exercise
// it from `testbench/replay.ts` against real recorded sessions, then
// iterate the rules until they hold for every fixture.
//
// Pure: no Node, no DOM, no IO. Importable from main, renderer, testbench.

const BOX_CHARS_RE = /[╭╮╰╯─│┌┐└┘├┤┬┴┼━┃═║]/g

/**
 * Markers that appear ONLY in CC's persistent bottom status row.
 * Validated against testbench/scripts/startup-trusted.json fixture
 * (recordings/2026-04-10T15-02-12-788Z). Add new markers when we discover
 * them by replaying fresh fixtures — keep this list specific so we don't
 * false-positive on real assistant content.
 */
const STATUS_LINE_MARKERS = [
  '⏵⏵',
  'bypass permissions on',
  'shift+tab to cycle',
  '/effort',
  'plan mode',
  'auto-accept edits',
]

/** A horizontal-rule line: at least 10 ─/━/═ chars and almost nothing else. */
export function isDividerLine(line: string): boolean {
  const dividerChars = (line.match(/[─━═▔]/g) ?? []).length
  if (dividerChars < 10) return false
  const nonSpace = line.replace(/\s/g, '').length
  return dividerChars >= nonSpace * 0.8
}

/** CC's prompt-indicator row: `❯` (or `>`) followed by whitespace only. */
export function isPromptLine(line: string): boolean {
  return /^\s*[❯>]\s*$/.test(line)
}

/** The persistent bottom status row that shows mode + effort + hints. */
export function isStatusLine(line: string): boolean {
  return STATUS_LINE_MARKERS.some(m => line.includes(m))
}

/**
 * A line is "chrome" if it's part of CC's persistent UI furniture (input
 * box, dividers, status row) rather than scrollable content. This is a
 * heuristic — exercised against fixtures in `recordings/`. Update when a
 * new fixture exposes a chrome pattern we don't yet recognize.
 */
export function isChromeLine(line: string): boolean {
  if (line.trim() === '') return true
  if (isDividerLine(line)) return true
  if (isPromptLine(line)) return true
  if (isStatusLine(line)) return true
  // Original heuristic: stripped of box-drawing chars there's nothing left.
  const stripped = line.replace(BOX_CHARS_RE, '').trim()
  if (stripped.length === 0) return true
  return false
}

/**
 * The glyph CC's Ink uses at the start of an assistant message line.
 * Looks like a filled circle (U+23FA "BLACK CIRCLE FOR RECORD"). Distinct
 * from `❯` which CC uses for the user's typed prompt indicator.
 *
 * If CC ever changes this glyph, only this constant + the regex below
 * need updating — the rest of `extractAssistantInProgress` is structural
 * (find-the-last-line-starting-with-marker).
 */
export const ASSISTANT_LINE_MARKER = '⏺'

const ASSISTANT_MARKER_RE = /^\s*⏺\s?/

/**
 * Strip the trailing input-box block from the bottom of the screen.
 * The input box is a contiguous run of chrome lines at the bottom — once
 * we hit non-chrome content scanning upward, we stop and keep everything
 * above that.
 *
 * This is a low-level primitive: it gives you everything CC was rendering
 * EXCEPT the persistent bottom UI furniture. It's still useful on its own
 * for debugging / fixture inspection / parsers that don't care about
 * assistant boundaries. For the streaming card you almost always want
 * `extractAssistantInProgress` instead, which composes on top of this.
 */
export function extractStreamingText(screen: string): string {
  if (!screen) return ''
  const lines = screen.split('\n')

  // Walk from the bottom up, finding the highest position where the
  // chrome block starts. Anything below that is the input box and gets cut.
  let cutFrom = lines.length
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isChromeLine(lines[i] ?? '')) {
      cutFrom = i
    } else {
      break
    }
  }

  const head = lines.slice(0, cutFrom)

  // Trim trailing blank/chrome lines from the top of what remains too —
  // CC sometimes leaves a few blank rows above the input box.
  while (head.length > 0 && isChromeLine(head[head.length - 1] ?? '')) {
    head.pop()
  }
  // And trim a leading run of blanks at the very top.
  let start = 0
  while (start < head.length && (head[start] ?? '').trim() === '') start++

  return head.slice(start).join('\n')
}

/**
 * Extract just the most-recent assistant text block from the screen.
 *
 * Pipeline:
 *   1. Strip the bottom chrome with `extractStreamingText` — that gives us
 *      everything ABOVE the input box (welcome banner, conversation
 *      history, in-progress assistant text).
 *   2. Walk lines from the bottom up until we find the last line that
 *      starts with the `⏺` assistant marker. Everything from that line
 *      forward is the most recent assistant block.
 *   3. Strip the marker from the head line so the rendered output reads
 *      as plain text.
 *
 * Why "last" `⏺` rather than "first":
 *   A turn can have multiple assistant blocks (text → tool_use → text).
 *   The user wants to see what's CURRENTLY being typed — that's the
 *   most recent block. Earlier blocks land in the JSONL feed and the
 *   structured renderer takes care of them — we don't double-render
 *   them in the streaming card.
 *
 * Why this exists separately from extractStreamingText:
 *   `extractStreamingText` is the chrome-stripper primitive — useful on
 *   its own for fixture inspection and other parsers. This function
 *   composes on top of it to give the streaming card exactly what it
 *   wants: just the current assistant text. Two functions means each
 *   has one job and each is independently testable from `replay.ts`.
 *
 * Why we return the first matching line and forward, not just the line:
 *   Multi-line assistant responses wrap with continuation lines that
 *   DON'T have the `⏺` marker — they're indented continuation. So once
 *   we find the marker, we keep everything from there to the end of the
 *   stripped content (not just that one line).
 *
 * Returns '' when no assistant marker is on screen yet — the streaming
 * card should fall back to a "thinking…" placeholder in that case.
 */
export function extractAssistantInProgress(screen: string): string {
  const stripped = extractStreamingText(screen)
  if (!stripped) return ''

  const lines = stripped.split('\n')
  let lastMarkerIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (ASSISTANT_MARKER_RE.test(lines[i] ?? '')) {
      lastMarkerIdx = i
      break
    }
  }
  if (lastMarkerIdx === -1) return ''

  // Slice from the marker line to the end, then strip the marker itself
  // off the head line so the output reads as plain text.
  const block = lines.slice(lastMarkerIdx)
  block[0] = (block[0] ?? '').replace(ASSISTANT_MARKER_RE, '')

  // Trim trailing blank lines that survived the chrome strip — they're
  // visual padding from CC's layout, not content.
  while (block.length > 0 && (block[block.length - 1] ?? '').trim() === '') {
    block.pop()
  }

  return block.join('\n')
}

