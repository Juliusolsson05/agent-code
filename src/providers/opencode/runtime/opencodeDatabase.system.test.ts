import { mkdtempSync, renameSync, rmSync } from 'node:fs'
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

it('keeps the handle when the path merely becomes unreadable, rather than trading it for an open that cannot succeed', async () => {
  const [only] = twoSessions()
  const target = join(dir, 'opencode.db')
  createProjectionDatabase(only, target)

  let clock = 0
  const database = createOpencodeDatabase({ resolveDbPath: async () => target, now: () => clock })
  databases.push(database)
  expect((await database.store()).readSessionInfo(only.meta.sessionID)).not.toBeNull()

  // OpenCode's data directory momentarily gone (an upgrade mid-write, a
  // network volume blinking). A stat failure is not evidence of a
  // REPLACEMENT, and the handle on the unlinked inode still answers, so it is
  // kept: the alternative is an open that throws for every caller.
  rmSync(target)
  clock += REVALIDATE_INTERVAL_MS
  expect((await database.store()).readSessionInfo(only.meta.sessionID)).not.toBeNull()
})
