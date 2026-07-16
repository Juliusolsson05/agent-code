export const COLLAPSED_TEXT_PREVIEW_CHARS = 2 * 1024
export const COLLAPSED_TEXT_PREVIEW_LINES = 6
export const TEXT_PAGE_MAX_CHARS = 16 * 1024
export const TEXT_PAGE_MAX_LINES = 400

export type BoundedTextPage = {
  text: string
  start: number
  end: number
  hasPrevious: boolean
  hasNext: boolean
}

export type BoundedTextLineCount = {
  /** Proven lower bound; exact when `truncated` is false. */
  count: number
  truncated: boolean
}

/**
 * Return one renderer-sized page without splitting the complete payload.
 *
 * WHY this scans only the requested window: the old "collapsed" rows called
 * `text.split('\n')` before deciding to show three lines. A multi-megabyte tool
 * result therefore allocated an array for every line even though almost none of
 * it reached the DOM. The page boundary is deliberately governed by both bytes
 * and lines: a character cap alone still permits thousands of one-character
 * lines, which is enough to create a pathological DOM/accessibility tree.
 */
export function boundedTextPage(
  source: string,
  start = 0,
  maxChars = TEXT_PAGE_MAX_CHARS,
  maxLines = TEXT_PAGE_MAX_LINES,
): BoundedTextPage {
  let safeStart = Math.min(Math.max(0, start), source.length)
  // WHY page boundaries are adjusted instead of accepting replacement glyphs: JavaScript indexes
  // UTF-16 code units, so a character budget can land between a surrogate pair. CRLF has the same
  // semantic issue for line-oriented output. Page navigation always uses the previous `end`, but
  // normalizing arbitrary starts also keeps callers/tests from manufacturing a broken first rune.
  if (safeStart > 0 && isLowSurrogate(source.charCodeAt(safeStart)) && isHighSurrogate(source.charCodeAt(safeStart - 1))) {
    safeStart -= 1
  }
  if (safeStart > 0 && source[safeStart] === '\n' && source[safeStart - 1] === '\r') {
    safeStart -= 1
  }
  const hardEnd = Math.min(source.length, safeStart + Math.max(1, maxChars))
  let lineBoundEnd: number | null = null
  let cursor = safeStart

  for (let line = 0; line < Math.max(1, maxLines); line += 1) {
    const newline = source.indexOf('\n', cursor)
    if (newline < 0 || newline >= hardEnd) break
    cursor = newline + 1

    if (line === maxLines - 1) lineBoundEnd = cursor
  }

  // If the line budget did not bind, preserve the character budget. When it
  // did bind, `lineBoundEnd` is the first byte after the final admitted newline.
  let end = lineBoundEnd ?? hardEnd
  if (end < source.length && end > safeStart) {
    if (isHighSurrogate(source.charCodeAt(end - 1)) && isLowSurrogate(source.charCodeAt(end))) {
      end -= 1
    }
    if (source[end - 1] === '\r' && source[end] === '\n') end -= 1
  }

  return {
    text: source.slice(safeStart, end),
    start: safeStart,
    end,
    hasPrevious: safeStart > 0,
    hasNext: end < source.length,
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xD800 && code <= 0xDBFF
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xDC00 && code <= 0xDFFF
}

/**
 * Detect content which must never be rendered as one code/text node.
 *
 * WHY the line test stops early: this predicate runs in render paths. It must
 * notice a tiny-but-line-dense payload without performing another full scan of
 * a huge result. Sixteen KiB is large enough for normal code snippets and small
 * enough that highlight.js plus DOM creation remains bounded on the renderer
 * thread; callers that need the remainder use `boundedTextPage`.
 */
export function exceedsInlineTextBudget(source: string): boolean {
  if (source.length > TEXT_PAGE_MAX_CHARS) return true

  let cursor = 0
  for (let line = 0; line < TEXT_PAGE_MAX_LINES; line += 1) {
    const newline = source.indexOf('\n', cursor)
    if (newline < 0) return false
    cursor = newline + 1
  }
  return cursor < source.length
}

export function collapsedTextPreview(source: string): BoundedTextPage {
  return boundedTextPage(
    source,
    0,
    COLLAPSED_TEXT_PREVIEW_CHARS,
    COLLAPSED_TEXT_PREVIEW_LINES,
  )
}

/** Count logical lines without allocating the array produced by split(). */
export function countTextLines(source: string): number {
  if (!source) return 0
  let count = 1
  let cursor = 0
  while (cursor < source.length) {
    const newline = source.indexOf('\n', cursor)
    if (newline < 0) break
    count += 1
    cursor = newline + 1
  }
  return count
}

/**
 * Count enough lines for a collapsed summary without scanning an arbitrarily large hidden source.
 *
 * WHY this is separate from `countTextLines`: callers which explicitly requested exact metadata
 * may accept an O(source) scan, but a closed disclosure is renderer admission work. Even one
 * enormous newline-free result makes `indexOf` traverse every byte. Reporting a proven lower bound
 * is more honest than freezing input for an exact number the user has not asked to inspect.
 */
export function boundedTextLineCount(
  source: string,
  maxLines = 10_000,
  maxChars = 256 * 1024,
): BoundedTextLineCount {
  if (!source) return { count: 0, truncated: false }
  const charLimit = Math.min(source.length, Math.max(1, maxChars))
  const lineLimit = Math.max(1, maxLines)
  let count = 1
  let cursor = 0
  while (cursor < charLimit && count < lineLimit) {
    if (source.charCodeAt(cursor) === 10) count += 1
    cursor += 1
  }
  return {
    count,
    truncated: cursor < source.length,
  }
}
