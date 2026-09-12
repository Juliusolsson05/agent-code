import { setTimeout as delay } from 'node:timers/promises'

import { OpencodeStoreError } from 'opencode-terminal-headless'

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

// SQLite BUSY is transient, unlike a missing file or a refused schema. Three
// attempts spaced over 75 ms absorb a short writer lock without leaving an IPC
// history request retrying forever. The final typed failure stays visible to
// the loader span, renderer and remote reply; empty is only a successful read.
const BUSY_RETRY_DELAYS_MS = [25, 50] as const

export function createOpencodeHistorySource(database: OpencodeDatabase): OpencodeHistorySource {
  return {
    async loadHistoryChunk(request) {
      for (let attempt = 0; ; attempt += 1) {
        let opening = true
        try {
          const store = await database.store()
          opening = false
          const page = store.readHistory(request.providerSessionId, {
            limit: request.limit,
            beforeMessageID: request.beforeMarker || undefined,
          })
          return {
            entries: page.records as unknown as Record<string, unknown>[],
            hasMore: page.hasOlder,
            ...(page.hasOlder && page.records[0] ? { oldestMarker: page.records[0].info.id } : {}),
            // Counts belong to initial hydration; older windows retain its total.
            ...(request.beforeMarker ? {} : { totalEntries: store.countMessages(request.providerSessionId) }),
          }
        } catch (cause) {
          const error = cause instanceof OpencodeStoreError ? cause : new OpencodeStoreError(
            opening ? 'open_failed' : 'read_failed',
            `OpenCode history unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          )
          const retryDelay = BUSY_RETRY_DELAYS_MS[attempt]
          if (error.code !== 'busy' || retryDelay === undefined) {
            // Electron transports Error.message, but not a custom .code. Keep
            // the typed category for main callers and repeat it in the message
            // so renderer history hydration retains the diagnosis.
            throw new OpencodeStoreError(error.code, `${error.code}: ${error.message}`, error)
          }
          await delay(retryDelay)
        }
      }
    },
  }
}

const defaultSource = createOpencodeHistorySource(opencodeDatabase)

export function loadOpencodeHistoryChunk(request: ProviderHistoryRequest): Promise<ProviderHistoryChunk> {
  return defaultSource.loadHistoryChunk(request)
}
