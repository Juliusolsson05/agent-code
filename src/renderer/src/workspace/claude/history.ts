import type { ConversationEntry } from '../../../../shared/types/transcript'

// Claude transcript markers + progress-wrapper unwrapping.
//
// Claude emits two shapes of conversation entries: flat {type:'user'|'assistant', uuid, …}
// for historical lines, and {type:'progress', data:{message:<flat-entry>}}
// for live streaming updates. The ghost reconciler and the older-
// history loader both want to address an entry by its uuid — so we
// look through the progress wrapper, extract the embedded flat
// entry, and use its uuid as the stable marker.
//
// `claudeHistoryMarker` answers "what uuid identifies this transcript
// line?". Returns null for non-conversation entries (system /
// compact_boundary) which don't participate in either path.
//
// `extractEmbeddedClaudeProgressEntry` produces a flat ConversationEntry
// from a progress wrapper — the shape the rest of cc-shell (Feed,
// reconciler, ghost ops) expects. Returns null for anything that
// isn't a progress wrapper holding a conversation entry.

export function claudeHistoryMarker(entry: Record<string, unknown>): string | null {
  const embedded = extractEmbeddedClaudeProgressEntry(entry)
  if (embedded?.uuid) return embedded.uuid
  return typeof entry.uuid === 'string' ? entry.uuid : null
}

export function extractEmbeddedClaudeProgressEntry(
  entry: Record<string, unknown>,
): ConversationEntry | null {
  if (entry.type !== 'progress') return null
  const data = entry.data as Record<string, unknown> | undefined
  const embedded = data?.message as Record<string, unknown> | undefined
  if (!embedded) return null

  const type = embedded.type
  if (type !== 'assistant' && type !== 'user') return null
  if (!embedded.message || typeof embedded.message !== 'object') return null

  return {
    type,
    uuid:
      typeof embedded.uuid === 'string'
        ? embedded.uuid
        : `${String(entry.timestamp ?? Date.now())}:progress:${type}`,
    parentUuid:
      typeof embedded.parentUuid === 'string' ? embedded.parentUuid : null,
    timestamp:
      typeof embedded.timestamp === 'string'
        ? embedded.timestamp
        : typeof entry.timestamp === 'string'
          ? entry.timestamp
          : undefined,
    sessionId:
      typeof embedded.sessionId === 'string'
        ? embedded.sessionId
        : typeof entry.sessionId === 'string'
          ? entry.sessionId
          : undefined,
    gitBranch:
      typeof embedded.gitBranch === 'string'
        ? embedded.gitBranch
        : typeof entry.gitBranch === 'string'
          ? entry.gitBranch
          : undefined,
    cwd:
      typeof embedded.cwd === 'string'
        ? embedded.cwd
        : typeof entry.cwd === 'string'
          ? entry.cwd
          : undefined,
    isSidechain: embedded.isSidechain === true,
    message: embedded.message as ConversationEntry['message'],
  }
}
