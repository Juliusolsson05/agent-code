// OpenCode transcript-entry mapper (#406, wiring step 2 stub — step 4
// replaces this with the real Message+Part[] → Entry translation).
//
// The stub maps NOTHING to the feed (entries: []) so a spawned
// opencode pane renders an empty feed rather than crashing on
// unmapped shapes; the semantic streaming card still renders live
// turns because it feeds off semantic-event, not this mapper.
// historyMarker stays null (no paging until the JSONL mirror exists,
// #406 blocker 2).
//
// extractProviderSessionId IS real: opencode's committed messages
// carry `info.sessionID` (nested — deliberately non-colliding with
// Claude's top-level sessionId and Codex's session_meta payload.id;
// Pass A runs every provider's extractor on every line, so wire-shape
// exclusivity is a correctness requirement, #394 phase 2c-3).

import type {
  MappedTranscriptEntry,
  TranscriptEntryMapper,
} from '@shared/types/providerConfig'

export function createOpencodeTranscriptEntryMapper(): TranscriptEntryMapper {
  return {
    map(_raw: Record<string, unknown>): MappedTranscriptEntry {
      return { entries: [], historyMarker: null }
    },
    getTurnCursor: () => null,
    setTurnCursor: () => {},
  }
}

export function extractOpencodeProviderSessionId(
  raw: Record<string, unknown>,
): string | null {
  const info = raw.info
  if (typeof info === 'object' && info !== null && !Array.isArray(info)) {
    const sessionID = (info as Record<string, unknown>).sessionID
    if (typeof sessionID === 'string' && sessionID.length > 0) return sessionID
  }
  // Envelope form: the runtime may attach sessionID at the top level
  // of the committed-entry payload.
  const sessionID = raw.sessionID
  return typeof sessionID === 'string' && sessionID.length > 0 ? sessionID : null
}
