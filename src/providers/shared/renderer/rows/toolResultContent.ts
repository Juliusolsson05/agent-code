import type { ToolResultBlock } from '@shared/types/transcript'
import { boundedJsonPreview } from '@renderer/lib/text/boundedJson'

/**
 * Bytes-free stand-in for a media part in a TEXT context.
 *
 * WHY this exists: this function is the last line of defence for the seven
 * production call sites that need a string. Before it, an image part fell to
 * `boundedJsonPreview`, which clamps strings at 512 chars — so the feed painted
 * 512 characters of base64 as JSON. Bounded, but still exactly the "base64
 * dump" the user reported, and still no image.
 *
 * The label deliberately carries no payload and no length: it is what a
 * copy-to-clipboard or a search index should see for an image, and neither
 * wants a truncated blob. The actual image is rendered from the structured
 * block by the painter — this is only the text projection.
 */
function mediaPartLabel(record: Record<string, unknown>): string | null {
  if (record.type !== 'image') return null

  // Both envelope spellings. Committed Claude blocks nest the payload under
  // `source` (`{source:{type:'base64', media_type, data}}`); the normalized
  // provider-neutral leaf and some MCP carriers put `mimeType`/`data` flat on
  // the block. ImageBlockRow already accepts both, so accepting only one here
  // would make the text projection disagree with the painter about what an
  // image is.
  const source = record.source as Record<string, unknown> | null | undefined
  const mime =
    typeof source?.media_type === 'string' ? source.media_type
    : typeof source?.mimeType === 'string' ? source.mimeType
    : typeof record.media_type === 'string' ? record.media_type
    : typeof record.mimeType === 'string' ? record.mimeType
    : null
  const payload =
    typeof source?.data === 'string' ? source.data
    : typeof record.data === 'string' ? record.data
    : null

  // WHY an image envelope with no payload falls through to the bounded
  // projector instead of getting a label: the label's entire justification is
  // that it replaces bytes nobody wants to read. With no bytes there is nothing
  // to protect against, and a future image schema we do not understand is
  // exactly the thing that must stay inspectable rather than being flattened to
  // "[image]". Suppressing structure we cannot explain is how a shape goes
  // missing without anyone noticing.
  if (!payload) return null

  return `[${mime ?? 'image'}]`
}

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
    // Checked BEFORE the bounded projector below, which would otherwise emit a
    // 512-char slice of the payload. A structural `type === 'image'` test is
    // deliberate: this module must not import the recognizer (see the
    // forbidden-importer list in docs/decomposition/image-read-base64-dump.md).
    // By the time content reaches here it has already been normalized to the
    // neutral image block at the transcript-mapping boundary, so dispatching on
    // the discriminator is reading a decision, not re-making one.
    const media = mediaPartLabel(record)
    if (media !== null) return media
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
