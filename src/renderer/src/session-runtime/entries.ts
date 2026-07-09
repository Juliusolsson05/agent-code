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
//   a diffable prop. We avoid allocating a new Map per entry during a
//   bootstrap burst (which used to be O(N²)).
//
// WHY this now RETURNS whether anything changed (feed audit Finding 1):
//   Because the map reference is stable, React context CANNOT see a
//   contents-only mutation — a provider value that is the same Map object
//   never invalidates consumers. The dangerous case is a CROSS-ENTRY
//   relation: a tool_use row mounted in an earlier entry renders its paired
//   result via `toolResultIndex.get(id)`, and when that result lands in a
//   LATER entry the already-mounted row would keep painting its stale
//   running/empty state (most visibly a rich GitCardRow). The fix keeps the
//   stable-map performance strategy but pairs it with a separate version
//   token: callers bump `toolIndexVersion` whenever this returns true, and
//   Feed ties its context value identity to that token. So the return value
//   is the SIGNAL that a cross-entry repaint is required — not a data-model
//   concern, purely a React invalidation token.
//
// "Changed" means: a new key was inserted, OR an existing key now maps to a
// DIFFERENT block reference (a result/use block was re-delivered/updated).
// Re-setting the identical reference is a no-op and must NOT bump the version,
// or bootstrap bursts would invalidate context on every duplicate append.
export function indexEntryIntoMaps(
  entry: Entry,
  toolUseIndex: Map<string, ToolUseBlock>,
  toolResultIndex: Map<string, ToolResultBlock>,
): boolean {
  if (!isConversationEntry(entry)) return false
  const content = entry.message.content
  if (!Array.isArray(content)) return false
  let changed = false
  for (const b of content) {
    if (b.type === 'tool_use') {
      const tu = b as ToolUseBlock
      if (toolUseIndex.get(tu.id) !== tu) {
        toolUseIndex.set(tu.id, tu)
        changed = true
      }
    } else if (b.type === 'tool_result') {
      const tr = b as ToolResultBlock
      if (toolResultIndex.get(tr.tool_use_id) !== tr) {
        toolResultIndex.set(tr.tool_use_id, tr)
        changed = true
      }
    }
  }
  return changed
}
