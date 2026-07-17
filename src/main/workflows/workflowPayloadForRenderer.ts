import type { ContentReference } from 'workflow-mcp/state'

const MAX_UNMARKED_RENDERER_TEXT_CHARACTERS = 10_000

/**
 * Remove heavyweight content from workflow DTOs before Electron structured-clones them.
 *
 * WHY this is a main-process compatibility boundary in addition to the producer limit: durable
 * runs outlive application versions. Runs written before the limit was enforced can contain a
 * four-kilobyte preview beside a megabyte-scale `content` object. Snapshot projection must still
 * read those records to recover state, but the renderer never needs the heavyweight copy when the
 * reference already declares itself truncated. Keeping this generic also covers every place a
 * ContentReference appears (prompts, outcomes, activity, logs, and final results) without a second
 * hand-maintained mirror of the workflow event union.
 */
export function workflowPayloadForRenderer<Value>(value: Value): Value {
  return visit(value) as Value
}

function visit(value: unknown): unknown {
  if (isContentReference(value)) {
    if (!shouldCompact(value)) return value
    return {
      ...value,
      content: value.preview,
      mediaType: 'text/plain',
      truncated: true,
    } satisfies ContentReference
  }
  if (Array.isArray(value)) {
    let changed = false
    const result = value.map(entry => {
      const next = visit(entry)
      if (next !== entry) changed = true
      return next
    })
    return changed ? result : value
  }
  if (value === null || typeof value !== 'object') return value

  let result: Record<string, unknown> | null = null
  for (const [key, entry] of Object.entries(value)) {
    const next = visit(entry)
    if (next === entry) continue
    if (!result) result = { ...(value as Record<string, unknown>) }
    result[key] = next
  }
  return result ?? value
}

function isContentReference(value: unknown): value is ContentReference {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<ContentReference>
  return typeof candidate.preview === 'string' && typeof candidate.lineCount === 'number'
}

function shouldCompact(reference: ContentReference): boolean {
  if (reference.truncated) return true
  return typeof reference.content === 'string'
    && reference.content.length > MAX_UNMARKED_RENDERER_TEXT_CHARACTERS
}
