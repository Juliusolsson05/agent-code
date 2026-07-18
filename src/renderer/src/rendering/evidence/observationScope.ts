import { asRecord } from '@shared/lib/asRecord'

export type CommittedBlockObservationDisposition =
  | 'content-native'
  | 'content-drift'
  | 'tool-use'
  | 'tool-result'
  | 'unknown-block'

/** The receipt names the fallback that actually owns known-label drift. */
export const CONTENT_BLOCK_DRIFT_FALLBACK_RENDER_ID = 'shared.content-block-envelope-drift'

function hasOnlyOwnKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  // WHY avoid Object.keys(...).sort(): this predicate runs at a paint decision
  // and receives untrusted provider data. A generated object with hundreds of
  // thousands of siblings must be classified as drift after the first unknown
  // key, not fully allocated merely to prove that it is malformed. Exact native
  // envelopes have at most four keys, so the successful path is inherently
  // tiny; the hostile path stops at its first unsupported sibling.
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue
    if (!allowed.has(key)) return false
  }
  return true
}

function isNativeTextBlock(block: Record<string, unknown>): boolean {
  return typeof block.text === 'string' &&
    hasOnlyOwnKeys(block, new Set(['type', 'text']))
}

function isNativeThinkingBlock(block: Record<string, unknown>): boolean {
  return typeof block.thinking === 'string' &&
    (block.signature === undefined || typeof block.signature === 'string') &&
    hasOnlyOwnKeys(block, new Set(['type', 'thinking', 'signature']))
}

function isNativeImageBlock(block: Record<string, unknown>): boolean {
  if (!hasOnlyOwnKeys(block, new Set(['type', 'source']))) return false
  const source = asRecord(block.source)
  if (!source || source.type !== 'base64' || typeof source.data !== 'string') return false

  const hasClaudeMime = Object.prototype.hasOwnProperty.call(source, 'media_type')
  const hasNormalizedMime = Object.prototype.hasOwnProperty.call(source, 'mimeType')
  if (hasClaudeMime === hasNormalizedMime) return false
  if (hasClaudeMime && typeof source.media_type !== 'string') return false
  if (hasNormalizedMime && typeof source.mimeType !== 'string') return false

  // WHY recognize both spellings but not arbitrary source maps: committed
  // Claude blocks use `media_type`, while the provider-neutral media leaf also
  // accepts normalized `mimeType`. Both select the same bounded base64 painter.
  // URL/file/future source kinds and any extra sibling may require a different
  // security or loading policy, so silently blessing them as the same native
  // shape would recreate C45's evidence gap.
  return hasOnlyOwnKeys(
    source,
    hasClaudeMime
      ? new Set(['type', 'media_type', 'data'])
      : new Set(['type', 'mimeType', 'data']),
  )
}

/** Payload-aware scope decision shared by runtime paint and fixture sweep.
 *
 * WHY known labels are insufficient: `ContentBlock` is intentionally open.
 * Treating every future `{type:'image', ...}` or `{type:'text', extra:...}` as
 * normalized hid structural provider drift from the shape inbox even though
 * the leaf silently ignored those fields. Only the exact, cheap envelopes the
 * current painters understand remain outside provider-routing evidence. Known
 * labels with novel structure are observed as content drift; unknown labels
 * retain their separate first-contact route.
 */
export function committedBlockObservationDisposition(
  payload: unknown,
): CommittedBlockObservationDisposition {
  const block = asRecord(payload)
  if (!block || typeof block.type !== 'string') return 'unknown-block'
  switch (block.type) {
    case 'text':
      return isNativeTextBlock(block) ? 'content-native' : 'content-drift'
    case 'thinking':
      return isNativeThinkingBlock(block) ? 'content-native' : 'content-drift'
    case 'image':
      return isNativeImageBlock(block) ? 'content-native' : 'content-drift'
    case 'tool_use':
      return 'tool-use'
    case 'tool_result':
      return 'tool-result'
    default:
      return 'unknown-block'
  }
}
