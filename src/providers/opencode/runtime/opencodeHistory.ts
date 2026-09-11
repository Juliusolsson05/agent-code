import { OpencodeStoreError, type OpencodeStore } from 'opencode-terminal-headless'

import type { ProviderHistoryChunk, ProviderHistoryRequest } from '@shared/types/providerConfig.js'

import { opencodeDatabase, type OpencodeDatabase } from './opencodeDatabase.js'

// OpenCode history for Agent Code's history loader, read from OpenCode's own
// database through opencode-terminal-headless's read-only store.
//
// WHY this exists: OpenCode has no transcript FILE, so the registry's
// `resolveTranscriptPath` returns null and the shared JSONL loader found
// nothing. That left every parked OpenCode agent — both runtimes — with an
// empty pane after restart and `transcript_unavailable` from the agent
// management MCP, and made OpenCode Terminal panes skip history entirely.
// The durable store answers "the newest N messages" and "the N before this
// message" with two indexed reads, with no OpenCode process running and no
// `opencode export` child (which spawns a Bun process and serializes the whole
// session on every call).
//
// Records are the `{ info, parts }` shape the renderer's OpenCode mapper folds,
// and the page cursor is that mapper's history marker (the message id).

export type OpencodeHistorySource = {
  loadHistoryChunk(request: ProviderHistoryRequest): Promise<ProviderHistoryChunk>
}

const EMPTY: ProviderHistoryChunk = { entries: [], hasMore: false, totalEntries: 0 }

export function createOpencodeHistorySource(database: OpencodeDatabase): OpencodeHistorySource {
  return {
    async loadHistoryChunk(request) {
      let store: OpencodeStore
      try {
        store = await database.store()
      } catch (error) {
        // No database (OpenCode not installed, unsupported schema): history is
        // empty, the same answer the file loader gives for a missing file.
        // The reason is still visible to anyone who looks.
        console.warn(
          `[opencodeHistory] OpenCode history unavailable: ${error instanceof OpencodeStoreError ? `${error.code}: ` : ''}${error instanceof Error ? error.message : String(error)}`,
        )
        return EMPTY
      }
      const page = store.readHistory(request.providerSessionId, {
        limit: request.limit,
        beforeMessageID: request.beforeMarker && request.beforeMarker.length > 0 ? request.beforeMarker : undefined,
      })
      return {
        entries: page.records as unknown as Record<string, unknown>[],
        hasMore: page.hasOlder,
        // Initial-load chunks carry the durable total, as the JSONL loader's
        // newline count does; older pages omit it.
        ...(request.beforeMarker ? {} : { totalEntries: store.countMessages(request.providerSessionId) }),
      }
    },
  }
}

const defaultSource = createOpencodeHistorySource(opencodeDatabase)

export function loadOpencodeHistoryChunk(request: ProviderHistoryRequest): Promise<ProviderHistoryChunk> {
  return defaultSource.loadHistoryChunk(request)
}
