import { asRecord } from '@shared/lib/asRecord'
import type { ToolResultBlock } from '@shared/types/transcript'

export type OpencodeReadDocument = {
  path: string
  content: string
  rawText: string
  complete: boolean
}

/**
 * Decode OpenCode's tagged read document without choosing any React surface.
 *
 * WHY this parser lives at the provider boundary: `<path>` and `<content>` are
 * transport vocabulary, while "show a read artifact" is shared product
 * vocabulary. Returning plain data keeps provider quirks out of the component
 * tree and lets the same ReadCard own live prefixes and committed results.
 *
 * The closing content tag is optional on purpose. Tool output can arrive as a
 * growing prefix, and waiting for the final tag recreates the exact UX failure
 * this rewrite targets: tag soup while streaming, then a component swap at
 * completion. Once an opening tag exists, the bytes after it are useful source
 * content. `complete` records whether the outer closing tag has arrived.
 */
export function parseOpencodeReadText(text: string): OpencodeReadDocument | null {
  const path = /<path>\s*([^<\n]+?)\s*<\/path>/.exec(text)?.[1]?.trim() ?? null
  const openingTag = '<content>'
  const bodyStartTag = text.indexOf(openingTag)
  if (!path || bodyStartTag < 0) return null

  let bodyStart = bodyStartTag + openingTag.length
  // OpenCode normally places the numbered source on the next line. Remove
  // only that envelope newline; further whitespace belongs to the file.
  if (text.startsWith('\r\n', bodyStart)) bodyStart += 2
  else if (text[bodyStart] === '\n') bodyStart += 1

  // The LAST closing tag terminates the envelope. Source files can themselves
  // contain the literal string `</content>` (documentation and tests do), so a
  // non-greedy regex would silently truncate valid file content.
  const closingTag = '</content>'
  const bodyEnd = text.lastIndexOf(closingTag)
  const complete = bodyEnd >= bodyStart
  const body = text.slice(bodyStart, complete ? bodyEnd : undefined)

  // OpenCode supplies a textual `N: ` gutter. ReadCard/CodeBlock owns line
  // numbering, so retaining it would show doubled gutters and make copied code
  // invalid. The unmodified envelope remains available through `rawText`.
  const content = body
    .split('\n')
    .map(line => line.replace(/^\s*\d+:\s?/, ''))
    .join('\n')

  return { path, content, rawText: text, complete }
}

export function parseOpencodeReadResult(
  block: ToolResultBlock,
): OpencodeReadDocument | null {
  const content = (block as { content?: unknown }).content
  if (typeof content === 'string') return parseOpencodeReadText(content)
  if (!Array.isArray(content)) return null

  const textBlock = content.find(item => asRecord(item)?.type === 'text')
  const text = asRecord(textBlock)?.text
  return typeof text === 'string' ? parseOpencodeReadText(text) : null
}
