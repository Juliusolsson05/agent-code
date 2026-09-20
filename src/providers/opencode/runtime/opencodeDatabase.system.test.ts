import { mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, it } from 'vitest'

import { openOpencodeStore } from 'opencode-terminal-headless'
import { createProjectionDatabase, listDurableFixtures, loadDurableFixture, type DurableFixture } from 'opencode-terminal-headless/testing/index'

import { createOpencodeDatabase, REVALIDATE_INTERVAL_MS, type OpencodeDatabase } from './opencodeDatabase.js'

// #910 item 4, reproduced the way the verifier did (V2): two REAL databases
// built from recorded sessions, one replacing the other at the same path. The
// package already selects a new generation when the device/inode under a path
// changes; this is the host's side of that, and before the fix it never
// reached it — the facade resolved the path once and kept the handle on the
// unlinked file for the life of the process.

let dir: string
let databases: OpencodeDatabase[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oc-db-'))
  databases = []
})
afterEach(() => {
  for (const database of databases) database.release()
  rmSync(dir, { recursive: true, force: true })
})

function twoSessions(): [DurableFixture, DurableFixture] {
  const names = listDurableFixtures().slice().sort()
  const first = loadDurableFixture(names[0]!)
  const second = loadDurableFixture(names[1]!)
  expect(first.meta.sessionID).not.toBe(second.meta.sessionID)
  return [first, second]
}

it('reads an opencode.db replaced at the same path, once the revalidation window has passed', async () => {
  const [before, after] = twoSessions()
  const target = join(dir, 'opencode.db')
  createProjectionDatabase(before, target)

  let clock = 0
  const database = createOpencodeDatabase({ resolveDbPath: async () => target, now: () => clock })
  databases.push(database)
  const first = await database.store()
  expect(first.readSessionInfo(before.meta.sessionID)).not.toBeNull()
  expect(first.readSessionInfo(after.meta.sessionID)).toBeNull()

  // The window passing over an UNCHANGED file must not churn the connection:
  // the same handle comes back, so the identity recorded at open time is a
  // real one and is really compared. A facade that reopened every interval
  // would drop and rebuild OpenCode's connection all day.
  clock += REVALIDATE_INTERVAL_MS
  expect(await database.store()).toBe(first)

  // A reinstall, a restore from backup, a `db path` that now points at a
  // rebuilt file: same path, new inode. The old file is unlinked but still
  // readable through the lease the facade holds, which is exactly what made
  // this invisible.
  const replacement = join(dir, 'replacement.db')
  createProjectionDatabase(after, replacement)
  renameSync(replacement, target)

  // Positive control: a store acquired DIRECTLY from the package already sees
  // the replacement, so whatever the facade still misses is the facade's
  // doing and not the package's generation selection.
  const direct = openOpencodeStore(target)
  try {
    expect(direct.readSessionInfo(after.meta.sessionID)).not.toBeNull()
  } finally {
    direct.release()
  }

  // Inside the window the cached handle is kept on purpose: the check is
  // bounded so that `store()` stays free on the hot path.
  clock += REVALIDATE_INTERVAL_MS - 1
  expect((await database.store()).readSessionInfo(after.meta.sessionID)).toBeNull()

  // Past it, the facade is on the new file — and no longer on the old one.
  clock += 1
  const reopened = await database.store()
  expect(reopened.readSessionInfo(after.meta.sessionID)).not.toBeNull()
  expect(reopened.readSessionInfo(before.meta.sessionID)).toBeNull()
})

it('closes the superseded handle at once when nobody is holding it', async () => {
  // The old connection must not survive the swap. A `setTimeout(…, 0)` release
  // — the first version of this fix — leaves it open past this point, and
  // never releasing it leaks one read-only connection per replacement.
  const [before, after] = twoSessions()
  const target = join(dir, 'opencode.db')
  createProjectionDatabase(before, target)
  let clock = 0
  const database = createOpencodeDatabase({ resolveDbPath: async () => target, now: () => clock })
  databases.push(database)
  const first = await database.store()

  const replacement = join(dir, 'replacement.db')
  createProjectionDatabase(after, replacement)
  renameSync(replacement, target)
  clock += REVALIDATE_INTERVAL_MS

  const second = await database.store()
  expect(second).not.toBe(first)
  expect(() => first.readSessionInfo(before.meta.sessionID)).toThrow(/after release/)
})

it('keeps a LEASED handle alive across the swap, and closes it when the lease drops', async () => {
  // #1082 review, finding 1. `AgentTranscriptReader` walks an OpenCode session
  // page by page and yields with `setImmediate` between pages, so it holds the
  // handle across awaits. The first version of this fix released the
  // superseded handle on a timer and argued that promise continuations drain
  // first — they do, and it is beside the point: a timer callback runs BEFORE
  // the check phase where `setImmediate` resumes. Counting holders is the fix.
  const [before, after] = twoSessions()
  const target = join(dir, 'opencode.db')
  createProjectionDatabase(before, target)
  let clock = 0
  const database = createOpencodeDatabase({ resolveDbPath: async () => target, now: () => clock })
  databases.push(database)
  const lease = await database.lease()

  const replacement = join(dir, 'replacement.db')
  createProjectionDatabase(after, replacement)
  renameSync(replacement, target)
  clock += REVALIDATE_INTERVAL_MS

  const swapped = await database.store()
  expect(swapped).not.toBe(lease.store)
  // The swap happened AND the walk's handle still reads. Both halves matter:
  // without the first the facade is wedged, without the second the walk dies.
  expect(swapped.readSessionInfo(after.meta.sessionID)).not.toBeNull()
  expect(lease.store.readSessionInfo(before.meta.sessionID)).not.toBeNull()

  lease.release()
  expect(() => lease.store.readSessionInfo(before.meta.sessionID)).toThrow(/after release/)
})

it('counts leases, so one holder releasing twice cannot close the handle under another', async () => {
  // A `finally` that runs twice, or a caller that releases and then releases
  // again on an error path, must not decrement someone else's hold.
  const [before, after] = twoSessions()
  const target = join(dir, 'opencode.db')
  createProjectionDatabase(before, target)
  let clock = 0
  const database = createOpencodeDatabase({ resolveDbPath: async () => target, now: () => clock })
  databases.push(database)
  const first = await database.lease()
  const second = await database.lease()
  expect(second.store).toBe(first.store)

  const replacement = join(dir, 'replacement.db')
  createProjectionDatabase(after, replacement)
  renameSync(replacement, target)
  clock += REVALIDATE_INTERVAL_MS
  await database.store()

  first.release()
  first.release()
  first.release()
  // `second` is still walking.
  expect(second.store.readSessionInfo(before.meta.sessionID)).not.toBeNull()
  second.release()
  expect(() => second.store.readSessionInfo(before.meta.sessionID)).toThrow(/after release/)
})

it('records the identity it observed BEFORE opening, so a replacement in that gap self-corrects', async () => {
  // #1082 review, finding 2b. Observing the identity AFTER the open takes a
  // third independent stat: a replacement landing between the package's own
  // confirming stat and ours records the NEW identity against a handle on the
  // OLD inode, which compares equal forever and can never be recovered.
  // Observing it first records a STALE identity instead — wrong in the
  // direction that the next interval fixes.
  const [before, after] = twoSessions()
  const target = join(dir, 'opencode.db')
  createProjectionDatabase(before, target)
  const replacement = join(dir, 'replacement.db')
  createProjectionDatabase(after, replacement)

  let clock = 0
  let swapDuringOpen = true
  const database = createOpencodeDatabase({
    resolveDbPath: async () => target,
    now: () => clock,
    openStore: path => {
      // The handle is opened on the OLD file, and the replacement lands
      // immediately after — the window between the package's own confirming
      // stat and any stat the facade takes afterwards.
      const store = openOpencodeStore(path)
      if (swapDuringOpen) {
        swapDuringOpen = false
        renameSync(replacement, target)
      }
      return store
    },
  })
  databases.push(database)
  // The handle really is on the old file: the replacement landed after it.
  expect((await database.store()).readSessionInfo(before.meta.sessionID)).not.toBeNull()

  // One interval later the facade must NOTICE that what it recorded no longer
  // matches the file — and reopen onto the replacement. Recording the identity
  // AFTER the open would have stored the NEW one against this OLD handle, and
  // no interval could ever recover from that.
  clock += REVALIDATE_INTERVAL_MS
  expect((await database.store()).readSessionInfo(after.meta.sessionID)).not.toBeNull()
})

it('keeps the handle when the path merely becomes unreadable, rather than trading it for an open that cannot succeed', async () => {
  const [only] = twoSessions()
  const target = join(dir, 'opencode.db')
  createProjectionDatabase(only, target)

  let clock = 0
  let opened = 0
  const database = createOpencodeDatabase({
    resolveDbPath: async () => target,
    now: () => clock,
    openStore: path => { opened += 1; return openOpencodeStore(path) },
  })
  databases.push(database)
  expect((await database.store()).readSessionInfo(only.meta.sessionID)).not.toBeNull()

  // OpenCode's data directory momentarily gone (an upgrade mid-write, a
  // network volume blinking). A stat failure is not evidence of a
  // REPLACEMENT, and the handle on the unlinked inode still answers, so it is
  // kept: the alternative is an open that throws for every caller.
  rmSync(target)
  clock += REVALIDATE_INTERVAL_MS
  expect((await database.store()).readSessionInfo(only.meta.sessionID)).not.toBeNull()
  // And it is kept WITHOUT attempting a reopen. Swapping here would be
  // rescued by the keep-what-works fallback, so the outcome alone cannot tell
  // the two apart — but it would burn an open attempt every interval for as
  // long as the path stays unreadable.
  expect(opened).toBe(1)
})

it('recovers when the identity could not be read at open time, instead of wedging for the process lifetime', async () => {
  // #1082 review, finding 2a. A single failed stat used to leave
  // `openedIdentity` null forever — and the early-return on null meant nothing
  // ever tried again, silently reinstating the exact bug this file fixes. One
  // spurious reopen is the honest price.
  const [before, after] = twoSessions()
  const target = join(dir, 'opencode.db')
  createProjectionDatabase(before, target)
  let clock = 0
  let identityReadable = false
  const database = createOpencodeDatabase({
    resolveDbPath: async () => target,
    now: () => clock,
    fileIdentity: path => (identityReadable ? realIdentity(path) : null),
  })
  databases.push(database)
  expect((await database.store()).readSessionInfo(before.meta.sessionID)).not.toBeNull()

  // The filesystem answers again, and the database is replaced.
  identityReadable = true
  const replacement = join(dir, 'replacement.db')
  createProjectionDatabase(after, replacement)
  renameSync(replacement, target)
  clock += REVALIDATE_INTERVAL_MS

  expect((await database.store()).readSessionInfo(after.meta.sessionID)).not.toBeNull()
})

it('keeps the working handle when the replacement cannot be opened', async () => {
  // #1082 review, finding 4. The stat-failure rule refuses to "trade a handle
  // that still reads for an open that cannot succeed" — and the
  // changed-identity path used to make exactly that trade. `opencode.db`
  // mid-rebuild has a new inode and is not yet a valid database.
  const [before] = twoSessions()
  const target = join(dir, 'opencode.db')
  createProjectionDatabase(before, target)
  let clock = 0
  let rebuilding = false
  const database = createOpencodeDatabase({
    resolveDbPath: async () => target,
    now: () => clock,
    openStore: path => {
      if (rebuilding) throw new Error('database is being rebuilt (SQLITE_NOTADB)')
      return openOpencodeStore(path)
    },
  })
  databases.push(database)
  const working = await database.store()
  expect(working.readSessionInfo(before.meta.sessionID)).not.toBeNull()

  // A NEW inode that is not yet a database — renamed into place, never
  // written over the old file, which would corrupt the inode still in use.
  rebuilding = true
  const half = join(dir, 'half-built.db')
  writeFileSync(half, 'not a database yet')
  renameSync(half, target)
  clock += REVALIDATE_INTERVAL_MS

  // The reader keeps working off the old inode rather than erroring.
  const still = await database.store()
  expect(still).toBe(working)
  expect(still.readSessionInfo(before.meta.sessionID)).not.toBeNull()

  // And the next interval tries again, so this self-heals rather than wedging.
  rebuilding = false
  const rebuilt = join(dir, 'rebuilt.db')
  createProjectionDatabase(before, rebuilt)
  renameSync(rebuilt, target)
  clock += REVALIDATE_INTERVAL_MS
  expect(await database.store()).not.toBe(working)
})

/** The real device/inode pair, in the same shape the facade records. */
function realIdentity(path: string): string {
  const stats = statSync(path, { bigint: true })
  return `${stats.dev}:${stats.ino}`
}
