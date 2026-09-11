import type { Conversation, ConversationActivitySource } from '@shared/conversations/types.js'
import { conversationKey } from '@shared/conversations/types.js'
import type { SourceConversation } from '../sources/types.js'

// docs/decomposition/conversations.md §2.4: last USER activity, never file
// mtime, because a background agent writing tool output every few seconds
// would otherwise outrank the session the user spent the afternoon in (#739).
// mtime is the last resort and is recorded as such so a test can prove an
// indexed provider never fell back to it.
export function activityOf(source: SourceConversation): { at: number; source: ConversationActivitySource } {
  if (source.lastUserActivityAt !== null && source.activitySource) return { at: source.lastUserActivityAt, source: source.activitySource }
  return { at: source.mtime, source: 'mtime' }
}

export function compareByActivity(a: Conversation, b: Conversation): number {
  if (b.lastUserActivityAt !== a.lastUserActivityAt) return b.lastUserActivityAt - a.lastUserActivityAt
  const ca = a.createdAt ?? 0
  const cb = b.createdAt ?? 0
  if (cb !== ca) return cb - ca
  return conversationKey(a.provider, a.nativeId) < conversationKey(b.provider, b.nativeId) ? -1 : 1
}

/** Cursor = activity timestamp + key of the last row on the page. Stable
 *  under new rows arriving above the page, which is the normal case while
 *  agents keep writing. */
export function encodeCursor(row: Conversation): string {
  return `${row.lastUserActivityAt}|${conversationKey(row.provider, row.nativeId)}`
}

export function decodeCursor(cursor: string): { at: number; key: string } | null {
  const bar = cursor.indexOf('|')
  if (bar <= 0) return null
  const at = Number(cursor.slice(0, bar))
  const key = cursor.slice(bar + 1)
  if (!Number.isFinite(at) || !key.includes(':')) return null
  return { at, key }
}
