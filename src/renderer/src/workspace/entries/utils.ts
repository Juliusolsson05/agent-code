import {
  isConversationEntry,
  type Entry,
  type ToolResultBlock,
  type ToolUseBlock,
} from '@shared/types/transcript'

// Shared entry utilities used by the workspace store, feed-debug log,
// and the bulk jsonl ingest path. Provider-agnostic: Claude and Codex
// conversation entries both use `message.content` arrays, so a single
// reader covers both shapes.

/** Pull user-visible text out of a conversation entry. Returns null
 *  when the entry isn't a user/assistant role or has no text block;
 *  useful for debug summaries and optimistic-reconciliation matching. */
export function entryTextContent(entry: Entry): string | null {
  if (entry.type !== 'user' && entry.type !== 'assistant') return null
  const content = (entry as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return null
  const texts = content
    .map(block => {
      const item = block as Record<string, unknown>
      return item.type === 'text' && typeof item.text === 'string' ? item.text : null
    })
    .filter((text): text is string => text !== null)
  return texts.length > 0 ? texts.join('\n') : null
}

/** One-line summary for the feed-debug log. Truncates long text so the
 *  log stays readable; the full entry is available in the data field. */
export function summarizeEntryForDebug(entry: Entry): string {
  const text = entryTextContent(entry)
  if (text) {
    const compact = text.replace(/\s+/g, ' ').trim()
    return `${entry.type}: ${compact.slice(0, 96)}`
  }
  return entry.type
}

// Mutates `toolUseIndex` and `toolResultIndex` in place, folding one
// feed entry's tool_use / tool_result blocks into the per-session
// lookup maps. Used by both the bulk jsonl-entries ingest path and
// the singular one — keeps the indexing logic in one place so Feed
// never has to rebuild these maps in a useMemo.
//
// WHY in-place mutation of a map stored on runtime state:
//   The map reference doesn't change, only its contents — Feed reads
//   through context and treats the map as a live lookup rather than
//   a diffable prop. React.memo of downstream rows is unaffected
//   (they don't depend on the map's reference identity), and we
//   avoid allocating a new Map per entry during a bootstrap burst.
export function indexEntryIntoMaps(
  entry: Entry,
  toolUseIndex: Map<string, ToolUseBlock>,
  toolResultIndex: Map<string, ToolResultBlock>,
): void {
  if (!isConversationEntry(entry)) return
  const content = entry.message.content
  if (!Array.isArray(content)) return
  for (const b of content) {
    if (b.type === 'tool_use') {
      const tu = b as ToolUseBlock
      toolUseIndex.set(tu.id, tu)
    } else if (b.type === 'tool_result') {
      const tr = b as ToolResultBlock
      toolResultIndex.set(tr.tool_use_id, tr)
    }
  }
}
