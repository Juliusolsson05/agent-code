import { statSync } from 'node:fs'

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
// WHY the cached handle is nevertheless re-validated (#910 item 4): the
// package keys its shared connection on path PLUS device/inode precisely so
// that an `opencode.db` replaced at the same path opens a new generation
// rather than keeping a lease on the unlinked file. The host never reached
// that: it resolved the path once and cached the handle for the process
// lifetime, so after a replacement it read the deleted inode forever — new
// sessions simply never appeared in history, Resume or the transcript tools
// until Agent Code restarted. `store()` therefore re-stats the file, at most
// once per REVALIDATE_INTERVAL_MS, and reopens when the identity changed.
//
// What this deliberately does NOT cover is the database MOVING: that answer
// comes from `resolveOpencodeDbPath`, which memoises for the process lifetime
// on purpose (one call costs a Bun process start; see launch/dbPath.ts's
// invalidation policy). Re-resolving here would pay that cost on every
// history call to catch a reinstall. Relocation stays a restart, as that file
// states; replacement in place does not.
//
// WHY a failed open is not cached: the next caller retries, so installing
// OpenCode or fixing its data directory takes effect without restarting
// Agent Code. The failure itself is thrown to each caller, which decides
// what "no database" means for it (unavailable history, an unreadable transcript,
// an unavailable locator).

// WHY 5 s and not "every call": `store()` is on the path of every history
// chunk and every transcript tool call, so the check has to be cheap and
// bounded. One `statSync` is microseconds, but doing it per call would still
// put a syscall in a hot loop for an event that needs someone to replace a
// file by hand. Five seconds is far below any human's "why is my new session
// missing" and far above the burst of calls a pane load makes.
export const REVALIDATE_INTERVAL_MS = 5_000

/**
 * The identity of the file the path resolves to, as the package's registry
 * keys it (device + inode). `statSync` follows symlinks, so this is the same
 * file the package would realpath to. Null when it cannot be read.
 */
function fileIdentityAt(path: string): string | null {
  try {
    const stats = statSync(path, { bigint: true })
    return `${stats.dev}:${stats.ino}`
  } catch {
    return null
  }
}

export type OpencodeDatabaseDeps = {
  resolveDbPath: () => Promise<string>
  openStore?: (dbPath: string) => OpencodeStore
  /** Test seams for the revalidation window; production uses the real clock and filesystem. */
  now?: () => number
  fileIdentity?: (path: string) => string | null
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
  // What `opened` is a handle on, and when we last checked that it still is.
  let openedPath: string | null = null
  let openedIdentity: string | null = null
  let checkedAt = 0
  const now = deps.now ?? Date.now
  const identityOf = deps.fileIdentity ?? fileIdentityAt

  /** True when the cached handle is known to be on a file that is no longer there. */
  const supersededByReplacement = (): boolean => {
    if (!opened || !openedPath || openedIdentity === null) return false
    if (now() - checkedAt < REVALIDATE_INTERVAL_MS) return false
    checkedAt = now()
    const current = identityOf(openedPath)
    // A stat that fails keeps the handle: a missing or momentarily unreadable
    // path is not evidence of a REPLACEMENT, and swapping on it would trade a
    // handle that still reads for an open that cannot succeed. Only a file
    // that is demonstrably a different one supersedes the lease.
    return current !== null && current !== openedIdentity
  }

  return {
    async store() {
      if (opened && !supersededByReplacement()) return opened
      if (opened) {
        // WHY the superseded handle is released on a TIMER rather than here:
        // every caller borrows this shared handle and reads from it
        // synchronously after `await store()`, and a promise continuation is a
        // microtask — all queued microtasks drain before the next timer
        // callback. Releasing inline could pull the handle out from under a
        // continuation that was already queued, and the package makes a
        // released handle throw. Nothing in the app holds the handle across a
        // further await; anything that ever needs to must take its own lease.
        const superseded = opened
        opened = null
        pending = null
        setTimeout(() => superseded.release(), 0).unref?.()
      }
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
          openedPath = path
          // Read AFTER the open, so the identity recorded is the one the
          // package validated its connection against (it refuses an open that
          // straddled a replacement). A replacement in the gap is simply the
          // next interval's business.
          openedIdentity = identityOf(path)
          checkedAt = now()
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
      openedPath = null
      openedIdentity = null
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
