import { boundedTextLineCount } from '@renderer/lib/text/boundedText'
import { asRecord } from '@shared/lib/asRecord'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

// Claude read/discovery wire -> provider-owned presentation models (Phase 7,
// PR #555). These models intentionally stay Claude-private for now. Read and
// ToolSearch are the only captured Claude grammars in this family, and no
// second provider currently maps to the same honest operation model. Creating
// a shared `read-search` protocol before that proof would merely rename a
// Claude parser as shared architecture — exactly the coupling this rewrite is
// removing.

const MAX_PATH_CHARS = 2_048
const MAX_QUERY_CHARS = 400
const MAX_TOOL_NAME_CHARS = 240
const MAX_VISIBLE_TOOL_REFERENCES = 50

export type ClaudeReadModel = {
  path: string
  offset: number | null
  limit: number | null
}

export type ClaudeReadResultModel = ClaudeReadModel & {
  content: string
  lineCount: number
  lineCountTruncated: boolean
  operationId: string
}

export type ClaudeToolSearchModel = {
  query: string
  maxResults: number | null
}

export type ClaudeToolSearchResultModel = ClaudeToolSearchModel & {
  tools: readonly string[]
  toolsTruncated: boolean
}

/**
 * Bound one scalar before it reaches title attributes, syntax detection, or
 * layout. Keeping both ends matters for paths: the workspace prefix explains
 * ownership while the basename/extension explains the target. The transcript
 * remains the exact source, so this display model never needs an unbounded raw
 * escape hatch.
 */
function boundScalar(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const head = Math.floor((maxChars - 1) / 2)
  const tail = maxChars - head - 1
  return `${value.slice(0, head)}…${value.slice(-tail)}`
}

function finiteNonNegativeNumber(value: unknown): number | null {
  // Offsets, limits, and result caps are counts, not arbitrary numeric
  // payloads. Rejecting fractions and unsafe integers keeps the renderer from
  // presenting nonsense such as "offset 1.5" or a rounded provider value as
  // though it were an exact location in a file/result set.
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

export function fromClaudeReadUse(block: ToolUseBlock): ClaudeReadModel | null {
  if (block.name !== 'Read') return null
  const input = asRecord(block.input)
  const rawPath = typeof input?.file_path === 'string' ? input.file_path : ''
  if (!/\S/.test(rawPath)) return null
  return {
    path: boundScalar(rawPath, MAX_PATH_CHARS),
    offset: finiteNonNegativeNumber(input?.offset),
    limit: finiteNonNegativeNumber(input?.limit),
  }
}

export function fromClaudeReadResult(
  result: ToolResultBlock,
  source: ToolUseBlock,
): ClaudeReadResultModel | null {
  const use = fromClaudeReadUse(source)
  // Pair identity is checked here even though the feed index already looked up
  // the source. The adapter is a trust boundary used by tests and future
  // operation dispatch too; accepting a mismatched result would make it
  // possible to paint one file's bytes under another file's path.
  if (!use || result.tool_use_id !== source.id || result.is_error === true) return null
  if (typeof result.content !== 'string') return null
  const count = boundedTextLineCount(result.content)
  return {
    ...use,
    content: result.content,
    lineCount: count.count,
    lineCountTruncated: count.truncated,
    operationId: source.id,
  }
}

export function fromClaudeToolSearchUse(block: ToolUseBlock): ClaudeToolSearchModel | null {
  if (block.name !== 'ToolSearch') return null
  const input = asRecord(block.input)
  const rawQuery = typeof input?.query === 'string' ? input.query : ''
  if (!/\S/.test(rawQuery)) return null
  return {
    query: boundScalar(rawQuery, MAX_QUERY_CHARS),
    maxResults: finiteNonNegativeNumber(input?.max_results),
  }
}

export function fromClaudeToolSearchResult(
  result: ToolResultBlock,
  source: ToolUseBlock,
): ClaudeToolSearchResultModel | null {
  const use = fromClaudeToolSearchUse(source)
  if (!use || result.tool_use_id !== source.id || result.is_error === true) return null
  if (!Array.isArray(result.content)) return null

  // Provider arrays are untrusted. Parsing only the visible prefix keeps the
  // render path bounded; `toolsTruncated` makes the summary a lower-bound claim
  // rather than pretending we validated a potentially enormous tail. Within
  // the admitted prefix we use parse-fully-or-decline: one malformed reference
  // sends the whole result back to the visible generic fallback.
  const admitted = result.content.slice(0, MAX_VISIBLE_TOOL_REFERENCES)
  const tools: string[] = []
  for (const item of admitted) {
    const record = asRecord(item)
    const rawName = typeof record?.tool_name === 'string' ? record.tool_name : ''
    if (record?.type !== 'tool_reference' || !/\S/.test(rawName)) return null
    tools.push(boundScalar(rawName, MAX_TOOL_NAME_CHARS))
  }
  return {
    ...use,
    tools,
    toolsTruncated: result.content.length > admitted.length,
  }
}

/**
 * Claude Read results carry their own `<digits>\t` gutter. CodeBlock paints a
 * real gutter, so preserving both makes source look corrupted. This transform
 * is deliberately page-scoped by CodeBlock: normalizing the complete hidden
 * result here would copy megabytes before the user opens the disclosure.
 * Lines that do not match the captured grammar survive verbatim.
 */
export function stripClaudeReadGutter(page: string): string {
  // WHY the boundary is a newline class rather than only LF: restored output
  // can retain CR-only terminal lines. The following whitespace class
  // deliberately excludes CR/LF; `\s*` crossed blank lines and silently
  // collapsed source layout while looking for the next numbered gutter.
  return page.replace(/(^|[\r\n])[^\S\r\n]*\d+\t/g, '$1')
}
