import { asRecord } from '@shared/lib/asRecord'
import { normalizeAllowedExternalUrl } from '@shared/renderedContent/targets'
import type { ToolUseBlock } from '@shared/types/transcript'

// Codex web activity is provider-native Responses API evidence, not an MCP
// schema. Rollout normalizes semantic `web_search_call` items into this one
// durable `web_search` block so live and replay can share the same card.

const MAX_LABEL_CHARS = 1_000
const MAX_URL_CHARS = 2_048

export type CodexWebModel = {
  operation: 'search' | 'open-page' | 'find-in-page'
  label: string
  url: string | null
  status: string | null
}

function bound(value: string): string {
  if (value.length <= MAX_LABEL_CHARS) return value
  const half = Math.floor((MAX_LABEL_CHARS - 1) / 2)
  return `${value.slice(0, half)}…${value.slice(-(MAX_LABEL_CHARS - half - 1))}`
}

function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_URL_CHARS) return null
  const normalized = normalizeAllowedExternalUrl(value)
  return normalized && normalized.length <= MAX_URL_CHARS ? normalized : null
}

export function fromCodexWebUse(block: ToolUseBlock): CodexWebModel | null {
  if (block.name !== 'web_search') return null
  const input = asRecord(block.input)
  if (!input) return null
  const kind = typeof input.kind === 'string' ? input.kind : 'search'
  const status = typeof input.status === 'string' ? bound(input.status) : null

  if (kind === 'search') {
    const query = typeof input.query === 'string' ? input.query : ''
    if (!/\S/.test(query)) return null
    return { operation: 'search', label: bound(query), url: null, status }
  }

  const url = safeUrl(input.url)
  if (!url) return null
  if (kind === 'open_page') {
    return { operation: 'open-page', label: bound(url), url, status }
  }
  if (kind === 'find_in_page') {
    const pattern = typeof input.pattern === 'string' ? input.pattern : ''
    // Old frozen rollout records predate pattern preservation. They still
    // prove the operation and target URL, so a deliberately generic label is
    // truthful; only new records claim the actual searched term.
    return {
      operation: 'find-in-page',
      label: /\S/.test(pattern) ? bound(pattern) : 'Find in page',
      url,
      status,
    }
  }
  return null
}
