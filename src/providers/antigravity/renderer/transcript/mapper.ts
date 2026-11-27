// Antigravity transcript-entry mapper, fed one `antigravity-row` per
// jsonl-entry event (antigravity-acp-headless AntigravityRow) — the same rows
// for live turns, history pages and replays.
//
// One row fans out into Claude-shaped feed entries:
//
//   user       -> user ConversationEntry                   <key>
//   assistant  -> assistant text entry                     <key>
//   thought    -> assistant thinking entry                 <key>
//   tool       -> assistant tool_use entry                 <key>
//                 + user tool_result entry, once finished  <key>:result
//
// WHY the row key is the uuid: rows are immutable and keyed by their ordinal
// in the conversation, identical for a live turn and its later replay
// (assembler.ts), so the ledger's dedupe-by-uuid absorbs a reload.
//
// The mapper is STATELESS (rows self-describe), so the turn cursor is a no-op.

import type { MappedTranscriptEntry, TranscriptEntryMapper } from '@shared/types/providerConfig'
import type { Entry } from '@shared/types/transcript'
import type { AntigravityRow } from 'antigravity-acp-headless'

/** The identity-only envelope AntigravitySession emits (no feed row). */
export const ANTIGRAVITY_IDENTITY_ENVELOPE_TYPE = 'antigravity-identity'
/** Every committed Antigravity row. */
export const ANTIGRAVITY_ROW_TYPE = 'antigravity-row'

const FINISHED = new Set(['completed', 'failed', 'cancelled', 'canceled', 'error'])

export function createAntigravityTranscriptEntryMapper(): TranscriptEntryMapper {
  return {
    map(raw: Record<string, unknown>): MappedTranscriptEntry {
      return mapAntigravityRowToFeedEntries(raw)
    },
    getTurnCursor: () => null,
    setTurnCursor: () => {},
  }
}

export function mapAntigravityRowToFeedEntries(raw: Record<string, unknown>): MappedTranscriptEntry {
  if (raw.type !== ANTIGRAVITY_ROW_TYPE || typeof raw.key !== 'string') return { entries: [], historyMarker: null }
  const row = raw as unknown as AntigravityRow
  const base = {
    uuid: row.key,
    parentUuid: null,
    timestamp: typeof row.timestamp === 'number' ? new Date(row.timestamp).toISOString() : undefined,
    sessionId: row.sessionId,
  }
  const entries: Entry[] = []
  switch (row.role) {
    case 'user':
      if (row.text) entries.push({ type: 'user', ...base, message: { role: 'user', content: [{ type: 'text', text: row.text }] } })
      break
    case 'assistant':
      if (row.text) entries.push({ type: 'assistant', ...base, message: { role: 'assistant', content: [{ type: 'text', text: row.text }] } })
      break
    case 'thought':
      if (row.text) entries.push({ type: 'assistant', ...base, message: { role: 'assistant', content: [{ type: 'thinking', thinking: row.text }] } })
      break
    case 'tool': {
      const tool = row.tool
      if (!tool) break
      entries.push({ type: 'assistant', ...base, message: { role: 'assistant', content: [{ type: 'tool_use', id: tool.toolCallId, name: tool.name, input: tool.input ?? {} }] } })
      if (FINISHED.has(tool.status) || tool.output !== null) {
        entries.push({
          type: 'user',
          ...base,
          uuid: `${row.key}:result`,
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: tool.toolCallId,
              // A replayed read has no output (agy does not replay it); say
              // what happened instead of an empty result box.
              content: tool.output ?? (tool.status === 'completed' ? 'Done.' : tool.status),
              is_error: tool.isError,
            }],
          },
        })
      }
      break
    }
  }
  return { entries, historyMarker: row.key }
}

/** Every Antigravity user row is a prompt the user typed (agy injects none). */
export function isAntigravityTypedUserPrompt(): boolean {
  return true
}

export function extractAntigravityProviderSessionId(raw: Record<string, unknown>): string | null {
  if (raw.type !== ANTIGRAVITY_IDENTITY_ENVELOPE_TYPE && raw.type !== ANTIGRAVITY_ROW_TYPE) return null
  return typeof raw.sessionId === 'string' && raw.sessionId.length > 0 ? raw.sessionId : null
}
