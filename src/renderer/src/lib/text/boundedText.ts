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
  const safeStart = Math.min(Math.max(0, start), source.length)
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
  const end = lineBoundEnd ?? hardEnd

  return {
    text: source.slice(safeStart, end),
    start: safeStart,
    end,
    hasPrevious: safeStart > 0,
    hasNext: end < source.length,
  }
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
