// Hermes history pages for a renderer that (re)attaches to a LIVE pane (#1482).
//
// WHY this exists (review a #2): a renderer reload (and the phone's backfill)
// adopts the still-running HermesSession in main and rebuilds the feed from
// the provider's history source. Every other provider has a durable local
// transcript to read; Hermes' conversation lives in the VPS's state.db, so
// with no source the rebuilt pane was EMPTY although main held the whole
// conversation. The rows the live session has already emitted are exactly
// what the renderer folded the first time, keyed exactly the same (the
// mapper's historyMarker is the row key), so serving them back makes a reload
// look like nothing happened, and live rows arriving afterwards dedupe by uuid.
//
// WHY not a fresh `session.history` call over the network: this must answer
// with no round trip and no second socket (the renderer asks while the pane
// is already connected), and the rows would be identical to what the session
// holds. A pane with no live session (the app restarted) gets nothing here:
// its next spawn resumes the conversation and replays it as a history reset.

import type { ProviderHistoryChunk, ProviderHistoryRequest } from '@shared/types/providerConfig.js'

/** One live conversation's committed rows, in display order, as emitted. */
export type HermesHistorySource = {
  connectionId: string
  rows: () => ReadonlyArray<Record<string, unknown> & { key: string }>
}

// Keyed by Hermes' stored session id: the only identity the history request
// carries (ProviderHistoryRequest.providerSessionId).
const live = new Map<string, HermesHistorySource>()

export function registerHermesHistory(storedSessionId: string, source: HermesHistorySource): () => void {
  live.set(storedSessionId, source)
  return () => {
    if (live.get(storedSessionId) === source) live.delete(storedSessionId)
  }
}

export async function loadHermesHistoryChunk(request: ProviderHistoryRequest): Promise<ProviderHistoryChunk> {
  const rows = live.get(request.providerSessionId)?.rows() ?? []
  // Paging by the mapper's marker (= the row key): everything strictly older.
  const end = request.beforeMarker ? rows.findIndex((row) => row.key === request.beforeMarker) : rows.length
  const upto = end < 0 ? 0 : end
  const start = Math.max(0, upto - Math.max(0, request.limit))
  const page = rows.slice(start, upto)
  return {
    entries: page.map((row) => ({ ...row })),
    hasMore: start > 0,
    totalEntries: rows.length,
    ...(start > 0 && page[0] ? { oldestMarker: page[0].key } : {}),
  }
}

/** The pane's transcript identity, also what HermesSession emits as `file`. */
export function hermesTranscriptSource(connectionId: string, storedSessionId: string): string {
  return `hermes://${connectionId}/${storedSessionId}`
}

export function hermesTranscriptLocator(storedSessionId: string): string {
  return hermesTranscriptSource(live.get(storedSessionId)?.connectionId ?? 'unknown', storedSessionId)
}

export function parseHermesTranscriptLocator(locator: string): string | null {
  return /^hermes:\/\/[^/]+\/(.+)$/.exec(locator)?.[1] ?? null
}
