import {
  openOpencodeStore,
  OpencodeStoreError,
  resolveOpencodeDbPath,
  type OpencodeSessionInfo,
  type OpencodeStore,
} from 'opencode-terminal-headless'

import { getToolPath } from '@main/setup/toolchain.js'

// Agent Code's one read-only handle on OpenCode's database, shared by every
// main-process reader that needs OpenCode sessions without an OpenCode
// process: history for parked and reloaded panes (opencodeHistory), the agent
// transcript MCP tools (AgentTranscriptReader) and Agent Management's
// transcript locator (transcriptLocator).
//
// WHY one handle for the app's lifetime: every OpenCode session on the
// machine lives in one database file, so there is nothing to scope a handle
// to. The package shares one connection per file anyway, and the process
// closes it on exit.
//
// WHY a failed open is not cached: the next caller retries, so installing
// OpenCode or fixing its data directory takes effect without restarting
// Agent Code. The failure itself is thrown to each caller, which decides
// what "no database" means for it (unavailable history, an unreadable transcript,
// an unavailable locator).

export type OpencodeDatabaseDeps = {
  resolveDbPath: () => Promise<string>
  openStore?: (dbPath: string) => OpencodeStore
}

export type OpencodeDatabase = {
  /** The shared store; rejects with the reason when OpenCode's database cannot be opened. */
  store(): Promise<OpencodeStore>
  release(): void
}

export function createOpencodeDatabase(deps: OpencodeDatabaseDeps): OpencodeDatabase {
  let pending: Promise<OpencodeStore> | null = null
  let opened: OpencodeStore | null = null
  let generation = 0

  return {
    async store() {
      if (opened) return opened
      if (!pending) {
        const openingGeneration = generation
        // A store() result is borrowed from this facade, not a new lease.
        // release() invalidates outstanding opens as well as borrowed handles;
        // a late resolver must neither leak a connection nor replace a newer
        // generation's pending/opened state after release-and-reacquire.
        const opening = deps.resolveDbPath().then(path => {
          if (generation !== openingGeneration) {
            throw new OpencodeStoreError('open_failed', 'OpenCode database open cancelled by release')
          }
          const store = (deps.openStore ?? openOpencodeStore)(path)
          if (generation !== openingGeneration) {
            store.release()
            throw new OpencodeStoreError('open_failed', 'OpenCode database open cancelled by release')
          }
          opened = store
          return store
        })
        pending = opening
        void opening.catch(() => {
          if (pending === opening) pending = null
        })
      }
      return await pending
    },
    release() {
      generation += 1
      opened?.release()
      opened = null
      pending = null
    },
  }
}

export const opencodeDatabase: OpencodeDatabase = createOpencodeDatabase({
  resolveDbPath: () =>
    resolveOpencodeDbPath({ binary: getToolPath('opencode', 'opencode'), env: process.env }),
})

/**
 * The session as OpenCode's database last recorded it, or null when the
 * session does not exist or the database cannot be read. For callers that
 * only need "is this session there, and when did it last change".
 */
export async function readOpencodeSessionInfo(
  sessionID: string,
  database: OpencodeDatabase = opencodeDatabase,
): Promise<OpencodeSessionInfo | null> {
  try {
    return (await database.store()).readSessionInfo(sessionID)
  } catch {
    return null
  }
}
