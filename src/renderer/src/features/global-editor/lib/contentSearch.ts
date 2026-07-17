import type { EditorFsSearchMatch } from '@shared/types/editorFs'

export type SearchableEditorBuffer = {
  path: string
  text: string
}

type MergeSearchMatchesResult = {
  matches: EditorFsSearchMatch[]
  truncated: boolean
}

function matchesForBuffer(
  buffer: SearchableEditorBuffer,
  query: string,
  caseSensitive: boolean,
  limit: number,
): MergeSearchMatchesResult {
  if (query.length === 0 || limit <= 0) return { matches: [], truncated: limit <= 0 }
  const insensitiveMatcher = caseSensitive
    ? null
    : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
  const matches: EditorFsSearchMatch[] = []
  // Match the main-process scan and Monaco's coordinate space. The editor
  // buffer retains BOM for save fidelity, but Monaco hides it outside the
  // editable range, so it must not consume column 1 in a navigation result.
  const text = buffer.text.startsWith('\ufeff') ? buffer.text.slice(1) : buffer.text
  let lineNumber = 1
  let lineStart = 0

  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? text.length : newline
    const line = text.slice(lineStart, lineEnd)
    const columns: Array<{ offset: number; length: number }> = []
    if (insensitiveMatcher) {
      insensitiveMatcher.lastIndex = 0
      for (
        let match = insensitiveMatcher.exec(line);
        match;
        match = insensitiveMatcher.exec(line)
      ) {
        columns.push({ offset: match.index, length: match[0].length })
      }
    } else {
      let offset = line.indexOf(query)
      while (offset !== -1) {
        columns.push({ offset, length: query.length })
        offset = line.indexOf(query, offset + Math.max(1, query.length))
      }
    }

    for (const { offset, length } of columns) {
      const previewStart = line.length > 200 ? Math.max(0, offset - 80) : 0
      matches.push({
        path: buffer.path,
        line: lineNumber,
        column: offset + 1,
        preview: line.slice(previewStart, previewStart + 200),
        previewMatchOffset: offset - previewStart,
        previewMatchLength: length,
      })
      if (matches.length >= limit) return { matches, truncated: true }
    }

    if (newline === -1) break
    lineStart = newline + 1
    lineNumber += 1
  }

  return { matches, truncated: false }
}

/**
 * Replace disk hits for recoverable editor buffers with hits from their live
 * text, preserving the main-process search bounds.
 *
 * WHY renderer-side replacement is required: the main process is correctly
 * authoritative for the project filesystem, but unsaved Monaco text has no
 * disk representation and must not cross into a second persistence/cache
 * channel just to support search. Keeping the overlay subscribed to buffer
 * snapshots also makes results update immediately as the user edits, without
 * re-walking the whole repository after every keystroke. The caller restarts
 * the disk scan when a buffer becomes clean, so large ordinary open files stay
 * on main's bounded scan path instead of being synchronously rescanned during
 * renderer render.
 */
export function mergeSearchMatchesWithBuffers(
  diskMatches: readonly EditorFsSearchMatch[],
  buffers: readonly SearchableEditorBuffer[],
  query: string,
  caseSensitive: boolean,
  limit = 500,
): MergeSearchMatchesResult {
  const livePaths = new Set(buffers.map(buffer => buffer.path))
  const matches: EditorFsSearchMatch[] = []
  let truncated = false

  // Live text is the only copy of unsaved content. Give it the bounded result
  // budget first; otherwise 500 earlier disk hits can crowd out the very edits
  // this merge exists to make searchable.
  for (const buffer of buffers) {
    const remaining = limit - matches.length
    if (remaining <= 0) return { matches, truncated: true }
    const live = matchesForBuffer(buffer, query, caseSensitive, remaining)
    matches.push(...live.matches)
    truncated ||= live.truncated
    if (matches.length >= limit) return { matches, truncated: true }
  }

  for (const match of diskMatches) {
    if (livePaths.has(match.path)) continue
    matches.push(match)
    if (matches.length >= limit) return { matches, truncated: true }
  }

  return { matches, truncated }
}
