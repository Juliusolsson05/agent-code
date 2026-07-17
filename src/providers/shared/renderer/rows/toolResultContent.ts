import type { ToolResultBlock } from '@shared/types/transcript'

function unknownPartText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    const text = (value as { text?: unknown }).text
    if (typeof text === 'string') return text
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }
  return String(value ?? '')
}

/**
 * One canonical, loss-averse flattening rule for result families that need a
 * text source. Typed MCP/media presenters still receive the original content;
 * this is their visible/raw fallback, not an attempt to interpret those
 * blocks. The single-item fast path avoids copying the common multi-megabyte
 * text result before the bounded viewer gets control.
 */
export function toolResultContentText(content: ToolResultBlock['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return unknownPartText(content)
  if (content.length === 0) return ''
  if (content.length === 1) return unknownPartText(content[0])
  return content.map(unknownPartText).join('\n')
}
