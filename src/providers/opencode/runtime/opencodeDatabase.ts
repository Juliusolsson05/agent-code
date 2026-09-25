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
// invalidation policy). Re-resolving is FREE — the memo answers every call,
// and `store()` already does it on every open — so what would actually cost a
// Bun start is INVALIDATING that memo on every history call to catch a
// reinstall. Relocation stays a restart, as that file states; replacement in
// place does not. (#1082 review, finding 5: the first version of this
// paragraph said re-resolving itself was the cost.)
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

/**
 * A borrow that stays valid across `await`s until it is released.
 *
 * WHY this exists (#1082 review, finding 1): a plain `store()` borrow is only
 * good until the caller's next await. `AgentTranscriptReader` walks an OpenCode
 * session one page at a time and deliberately yields with `setImmediate`
 * between pages; a revalidation that retired the handle during one of those
 * yields left the walk holding a released store, which throws. The first draft
 * of this file released the superseded handle on `setTimeout(…, 0)` and argued
 * that promise continuations drain first — true for a synchronous reader, and
 * irrelevant here, because a timer callback runs BEFORE the check phase where
 * `setImmediate` resumes. Counting the holders is the fix; guessing at phase
 * order is not.
 */
export type OpencodeLease = {
  store: OpencodeStore
  /** Idempotent. Releasing the last lease on a retired handle closes it. */
  release(): void
}

export type OpencodeDatabase = {
  /**
   * The shared store, valid until the caller's next `await` — every consumer
   * that only reads synchronously after the await wants this. Rejects with the
   * reason when OpenCode's database cannot be opened.
   */
  store(): Promise<OpencodeStore>
  /** The shared store, held across awaits. The caller MUST release it. */
  lease(): Promise<OpencodeLease>
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
  // True from the moment a replacement is observed until the new handle is in
  // hand. `opened` keeps serving throughout, so a reopen that fails costs
  // nothing: the old file is still readable, and the next interval retries.
  let replacing = false
  const now = deps.now ?? Date.now
  const identityOf = deps.fileIdentity ?? fileIdentityAt
  // Outstanding leases per handle. A handle retired while leases are open is
  // closed by the last `release()`, never before.
  const leaseCounts = new Map<OpencodeStore, number>()
  const retiredHandles = new Set<OpencodeStore>()

  const dropLease = (store: OpencodeStore): void => {
    const remaining = (leaseCounts.get(store) ?? 0) - 1
    if (remaining > 0) {
      leaseCounts.set(store, remaining)
      return
    }
    leaseCounts.delete(store)
    if (retiredHandles.delete(store)) store.release()
  }

  /** Close a handle this facade no longer serves, once nobody is holding it. */
  const retire = (store: OpencodeStore): void => {
    if (leaseCounts.has(store)) retiredHandles.add(store)
    else store.release()
  }

  /** True when the cached handle is on a file that has since been replaced. */
  const supersededByReplacement = (): boolean => {
    if (!opened || !openedPath) return false
    if (now() - checkedAt < REVALIDATE_INTERVAL_MS) return false
    checkedAt = now()
    const current = identityOf(openedPath)
    // A stat that fails keeps the handle: a missing or momentarily unreadable
    // path is not evidence of a REPLACEMENT, and swapping on it would trade a
    // handle that still reads for an open that cannot succeed.
    //
    // A NULL recorded identity, though, means we never managed to read one —
    // and must not wedge revalidation off for the process lifetime, which is
    // the exact bug this file fixes (#1082 review, finding 2a). The first
    // successful stat after that counts as a change, costing one spurious
    // reopen that then records a real identity.
    return current !== null && current !== openedIdentity
  }

  const acquire = async (): Promise<OpencodeStore> => {
    if (opened && !replacing && !supersededByReplacement()) return opened
    if (opened && !replacing) {
      replacing = true
      pending = null
    }
    if (!pending) {
      const openingGeneration = generation
      const previous = opened
      // A store() result is borrowed from this facade, not a new lease.
      // release() invalidates outstanding opens as well as borrowed handles;
      // a late resolver must neither leak a connection nor replace a newer
      // generation's pending/opened state after release-and-reacquire.
      const opening = deps.resolveDbPath().then(path => {
        if (generation !== openingGeneration) {
          throw new OpencodeStoreError('open_failed', 'OpenCode database open cancelled by release')
        }
        // Stat BEFORE the open, not after (#1082 review, finding 2b). Reading
        // it afterwards takes a THIRD independent stat, and a replacement
        // landing between the package's own confirming stat and ours records
        // the NEW identity against a handle on the OLD inode — which compares
        // equal forever and can never be recovered. Observing it first makes
        // the same race record a STALE identity instead, which the next
        // interval corrects with one reopen.
        const identity = identityOf(path)
        const store = (deps.openStore ?? openOpencodeStore)(path)
        if (generation !== openingGeneration) {
          store.release()
          throw new OpencodeStoreError('open_failed', 'OpenCode database open cancelled by release')
        }
        opened = store
        openedPath = path
        openedIdentity = identity
        checkedAt = now()
        replacing = false
        // Only now is the new handle in hand, so only now may the old one go.
        if (previous && previous !== store) retire(previous)
        return store
      })
      pending = opening
      void opening.catch(() => {
        if (pending === opening) pending = null
      })
    }
    try {
      return await pending
    } catch (error) {
      // A reopen that failed while a WORKING handle is still held is not a
      // failure the caller should see: `opencode.db` mid-rebuild has a new
      // inode and is not yet a valid database. Keep serving the old file and
      // let the next interval try again.
      if (replacing && opened) {
        replacing = false
        pending = null
        return opened
      }
      throw error
    }
  }

  return {
    store: acquire,
    async lease() {
      const store = await acquire()
      leaseCounts.set(store, (leaseCounts.get(store) ?? 0) + 1)
      let released = false
      return {
        store,
        release() {
          if (released) return
          released = true
          dropLease(store)
        },
      }
    },
    release() {
      generation += 1
      if (opened) retire(opened)
      opened = null
      openedPath = null
      openedIdentity = null
      replacing = false
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
