// Claude transcript-entry mapper — the provider-owned half of JSONL
// ingestion (#394 phase 2b).
//
// WHY this exists: the exact same "unwrap progress wrapper → filter to
// conversation/compact entries → derive uuid marker" sequence was
// duplicated in FOUR places (live ingest, initial history, older
// history, session preview), each hand-forked against the codex
// equivalent. The mapper owns the provider-specific mapping; the call
// sites keep their genuinely site-specific policies (dedupe, tool
// indexing, marker-update rules, optimistic reconciliation).
//
// The Claude mapper is stateless — Claude entries carry stable uuids
// and no cross-entry turn cursor. The TranscriptEntryMapper interface
// still has the cursor methods (no-ops here) because Codex's mapper
// needs them and the call sites treat mappers uniformly.

import type { Entry } from '@shared/types/transcript'
import {
  isCompactBoundaryEntry,
  isCompactSummaryEntry,
  isConversationEntry,
} from '@shared/types/transcript'
import type {
  MappedTranscriptEntry,
  TranscriptEntryMapper,
} from '@shared/types/providerConfig'
import {
  claudeHistoryMarker,
  extractEmbeddedClaudeProgressEntry,
} from './history'

export function createClaudeTranscriptEntryMapper(): TranscriptEntryMapper {
  return {
    map(raw: Record<string, unknown>): MappedTranscriptEntry {
      const feedEntry = extractEmbeddedClaudeProgressEntry(raw) ?? (raw as Entry)
      const marker = claudeHistoryMarker(raw)
      // The conversation/compact filter lives HERE (not at call sites)
      // so all four ingestion paths inherit identical semantics — the
      // old duplication had already drifted (live ingest cleared
      // pendingCompaction on compact summaries, bootstrap didn't; the
      // caller keeps that decision, but what COUNTS as a feed entry is
      // provider truth and belongs to the provider).
      if (
        !isConversationEntry(feedEntry) &&
        !isCompactBoundaryEntry(feedEntry) &&
        !isCompactSummaryEntry(feedEntry)
      ) {
        return { entries: [], historyMarker: marker }
      }
      return { entries: [feedEntry], historyMarker: marker }
    },
    // Claude has no rolling turn cursor — uuids are stable per entry.
    getTurnCursor: () => null,
    setTurnCursor: () => {},
  }
}

/**
 * Pass-A identity capture: which durable provider session id does this
 * raw line claim? Claude stamps `sessionId` on (almost) every entry.
 */
export function extractClaudeProviderSessionId(
  raw: Record<string, unknown>,
): string | null {
  return typeof raw.sessionId === 'string' && raw.sessionId.length > 0
    ? raw.sessionId
    : null
}
