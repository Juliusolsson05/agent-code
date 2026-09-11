import {
  openOpencodeStore,
  OpencodeStoreError,
  resolveOpencodeDbPath,
  type OpencodeStore,
} from 'opencode-terminal-headless'

import { getToolPath } from '@main/setup/toolchain.js'
import type { ProviderHistoryChunk, ProviderHistoryRequest } from '@shared/types/providerConfig.js'

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
//
// WHY one store handle for the app's lifetime: every OpenCode session on the
// machine lives in one database file. The package shares one read-only
// connection per file, and the process closes it on exit. A failed open is
// not cached: the next request retries, so installing OpenCode or fixing its
// data directory takes effect without restarting Agent Code.

export type OpencodeHistorySourceDeps = {
  resolveDbPath: () => Promise<string>
  openStore?: (dbPath: string) => OpencodeStore
}

export type OpencodeHistorySource = {
  loadHistoryChunk(request: ProviderHistoryRequest): Promise<ProviderHistoryChunk>
  release(): void
}

const EMPTY: ProviderHistoryChunk = { entries: [], hasMore: false, totalEntries: 0 }

export function createOpencodeHistorySource(deps: OpencodeHistorySourceDeps): OpencodeHistorySource {
  let pending: Promise<OpencodeStore> | null = null
  let store: OpencodeStore | null = null

  const getStore = async (): Promise<OpencodeStore> => {
    if (store) return store
    if (!pending) {
      pending = deps.resolveDbPath().then(path => {
        store = (deps.openStore ?? openOpencodeStore)(path)
        return store
      })
      pending.catch(() => {
        pending = null
      })
    }
    return await pending
  }

  return {
    async loadHistoryChunk(request) {
      let opened: OpencodeStore
      try {
        opened = await getStore()
      } catch (error) {
        // No database (OpenCode not installed, unsupported schema): history is
        // empty, the same answer the file loader gives for a missing file.
        // The reason is still visible to anyone who looks.
        console.warn(
          `[opencodeHistory] OpenCode history unavailable: ${error instanceof OpencodeStoreError ? `${error.code}: ` : ''}${error instanceof Error ? error.message : String(error)}`,
        )
        return EMPTY
      }
      const page = opened.readHistory(request.providerSessionId, {
        limit: request.limit,
        beforeMessageID: request.beforeMarker && request.beforeMarker.length > 0 ? request.beforeMarker : undefined,
      })
      return {
        entries: page.records as unknown as Record<string, unknown>[],
        hasMore: page.hasOlder,
        // Initial-load chunks carry the durable total, as the JSONL loader's
        // newline count does; older pages omit it.
        ...(request.beforeMarker ? {} : { totalEntries: opened.countMessages(request.providerSessionId) }),
      }
    },
    release() {
      store?.release()
      store = null
      pending = null
    },
  }
}

const defaultSource = createOpencodeHistorySource({
  resolveDbPath: () =>
    resolveOpencodeDbPath({ binary: getToolPath('opencode', 'opencode'), env: process.env }),
})

export function loadOpencodeHistoryChunk(request: ProviderHistoryRequest): Promise<ProviderHistoryChunk> {
  return defaultSource.loadHistoryChunk(request)
}
