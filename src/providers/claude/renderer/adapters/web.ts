import { boundedTextLineCount } from '@renderer/lib/text/boundedText'
import { asRecord } from '@shared/lib/asRecord'
import { normalizeAllowedExternalUrl } from '@shared/renderedContent/targets'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

// Claude's WebFetch/WebSearch blocks look superficially similar to Codex web
// events, but the evidence does not support one shared wire adapter: Claude
// owns committed tool_use + paired string results while Codex exposes both
// semantic web_search_call events and committed wrappers. Keep this grammar
// provider-private until a genuinely shared presentation protocol is proven.

const MAX_URL_CHARS = 2_048
const MAX_PROMPT_CHARS = 1_000
const MAX_QUERY_CHARS = 1_000
const MAX_URL_LABEL_CHARS = 240

export type ClaudeWebFetchModel = {
  url: string
  urlLabel: string
  prompt: string
}

export type ClaudeWebFetchResultModel = ClaudeWebFetchModel & {
  content: string
  lineCount: number
  lineCountTruncated: boolean
}

export type ClaudeWebSearchModel = {
  query: string
}

export type ClaudeWebSearchResultModel = ClaudeWebSearchModel & {
  content: string
  lineCount: number
  lineCountTruncated: boolean
}

/**
 * Presentation text is bounded before it reaches title attributes or layout.
 * Keeping both ends preserves the useful hostname/basename or query ending;
 * exact durable content remains available in the transcript/result model.
 */
function boundScalar(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const head = Math.floor((maxChars - 1) / 2)
  const tail = maxChars - head - 1
  return `${value.slice(0, head)}…${value.slice(-tail)}`
}

function admittedHttpUrl(value: unknown): { url: string; label: string } | null {
  if (typeof value !== 'string' || value.length > MAX_URL_CHARS) return null
  const url = normalizeAllowedExternalUrl(value)
  // Normalization may expand Unicode into percent-encoded bytes. Bound the
  // actual href too; checking only the source would let a short-looking URL
  // become an unexpectedly large DOM/navigation attribute.
  if (!url || url.length > MAX_URL_CHARS) return null

  // URL normalization has already enforced http(s). Parsing the admitted URL
  // again is safe and lets the visible label omit query/hash material, which
  // is often tracking noise or a credential-like token. The exact normalized
  // URL remains the click target; only the compact label is lossy.
  const parsed = new URL(url)
  const path = parsed.pathname === '/' ? '' : parsed.pathname
  return { url, label: boundScalar(`${parsed.host}${path}`, MAX_URL_LABEL_CHARS) }
}

export function fromClaudeWebFetchUse(block: ToolUseBlock): ClaudeWebFetchModel | null {
  if (block.name !== 'WebFetch') return null
  const input = asRecord(block.input)
  const admitted = admittedHttpUrl(input?.url)
  const rawPrompt = typeof input?.prompt === 'string' ? input.prompt : ''
  if (!admitted || !/\S/.test(rawPrompt)) return null
  return {
    url: admitted.url,
    urlLabel: admitted.label,
    prompt: boundScalar(rawPrompt, MAX_PROMPT_CHARS),
  }
}

export function fromClaudeWebFetchResult(
  result: ToolResultBlock,
  source: ToolUseBlock,
): ClaudeWebFetchResultModel | null {
  const use = fromClaudeWebFetchUse(source)
  // Pair identity is rechecked at the adapter boundary. A feed lookup is not
  // sufficient proof for every future caller, and painting one page's text
  // under another URL would be a materially false attribution.
  if (!use || result.tool_use_id !== source.id || result.is_error === true) return null
  if (typeof result.content !== 'string') return null
  const count = boundedTextLineCount(result.content)
  return {
    ...use,
    content: result.content,
    lineCount: count.count,
    lineCountTruncated: count.truncated,
  }
}

export function fromClaudeWebSearchUse(block: ToolUseBlock): ClaudeWebSearchModel | null {
  if (block.name !== 'WebSearch') return null
  const input = asRecord(block.input)
  const rawQuery = typeof input?.query === 'string' ? input.query : ''
  if (!/\S/.test(rawQuery)) return null
  return { query: boundScalar(rawQuery, MAX_QUERY_CHARS) }
}

export function fromClaudeWebSearchResult(
  result: ToolResultBlock,
  source: ToolUseBlock,
): ClaudeWebSearchResultModel | null {
  const use = fromClaudeWebSearchUse(source)
  if (!use || result.tool_use_id !== source.id || result.is_error === true) return null
  if (typeof result.content !== 'string') return null
  const count = boundedTextLineCount(result.content)
  return {
    ...use,
    content: result.content,
    lineCount: count.count,
    lineCountTruncated: count.truncated,
  }
}
