import type { ToolResultBlock } from '@shared/types/transcript'
import { boundedJsonPreview } from '@renderer/lib/text/boundedJson'

function unknownPartText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    if (
      record.type === 'text' &&
      typeof record.text === 'string' &&
      keys.every(key => key === 'type' || key === 'text')
    ) {
      return record.text
    }
    // A hybrid text block's sibling fields may contain citations, annotations, or future typed
    // semantics; returning only .text would erase them. Conversely, JSON.stringify on an image
    // block eagerly copies its full base64 payload before a bounded viewer can help. The bounded
    // projector preserves representative structure and emits explicit ellipses without traversing
    // or allocating the complete provider-controlled object.
    return boundedJsonPreview(value) ?? String(value)
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
