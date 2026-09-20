import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { acquireStateProcessLock } from './processLock.js'
import type { StateProcessLockOwner } from './processLock.js'

// ---------------------------------------------------------------------------
// The lock that is supposed to guarantee ONE main process per state directory
// had no tests at all, which is how #993 got here: on 2026-09-18 a dev build
// and the installed app ran against `~/.config/agent-code` simultaneously
// while the lock file DID NOT EXIST — no live owner, no stale lock, just
// absent, with the dev process actively writing control history and layout.
//
// These drive the real `acquireStateProcessLock` against a real directory.
// Only the two things a test genuinely cannot supply are injected, through the
// options the function already accepts: the clock, and the answer to "is that
// pid still an Agent Code?" (which really runs `ps`).
// ---------------------------------------------------------------------------

let stateDir: string
let lockPath: string

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'state-lock-'))
  lockPath = join(stateDir, 'agent-code.process-lock.json')
})
afterEach(async () => { await rm(stateDir, { recursive: true, force: true }) })

async function writeOwner(owner: Partial<StateProcessLockOwner> = {}): Promise<StateProcessLockOwner> {
  const full: StateProcessLockOwner = {
    token: 'owner-token',
    pid: 4242,
    startedAt: new Date('2026-09-18T10:00:00Z').toISOString(),
    argv0: '/Users/dev/agent-code/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
    ...owner,
  }
  await writeFile(lockPath, `${JSON.stringify(full, null, 2)}\n`, 'utf8')
  return full
}

const at = (iso: string) => () => new Date(iso)

describe('the lock refuses a second main process', () => {
  it('acquires a free directory and writes an owner the next process can read', async () => {
    const lock = await acquireStateProcessLock({ stateDir, pid: 100, argv0: '/apps/Agent Code' })
    expect(lock.acquired).toBe(true)
    const written = JSON.parse(await readFile(lockPath, 'utf8')) as StateProcessLockOwner
    expect(written).toMatchObject({ pid: 100, argv0: '/apps/Agent Code' })
  })

  it('refuses when the recorded owner is confirmed alive', async () => {
    await writeOwner()
    const lock = await acquireStateProcessLock({
      stateDir, pid: 100, isLockOwnerActive: () => 'active',
    })
    expect(lock).toMatchObject({ acquired: false, reason: 'active-owner' })
    // The incumbent's lock is untouched — refusing must never disarm it.
    expect(existsSync(lockPath)).toBe(true)
  })

  it('takes over a lock whose owner is confirmed DEAD', async () => {
    await writeOwner()
    const lock = await acquireStateProcessLock({
      stateDir, pid: 100, argv0: '/apps/Agent Code', isLockOwnerActive: () => 'inactive',
    })
    expect(lock.acquired).toBe(true)
    const written = JSON.parse(await readFile(lockPath, 'utf8')) as StateProcessLockOwner
    expect(written.pid).toBe(100)
  })
})

describe('a LIVE pid is never stolen from on a heuristic (#993)', () => {
  // `defaultIsLockOwnerActive` answers 'inactive' in two very different
  // situations: the pid is GONE, and the pid is ALIVE but `ps` did not show a
  // command line matching the recorded argv0. The second is a guess — an app
  // updated in place, a renamed bundle, a dev binary at a moved path — and
  // acting on it takes the lock away from a process that is still writing.
  //
  // That is the only mechanism that produces #993's exact evidence: two live
  // mains, and then NO lock file at all, because whichever one exits first
  // matches its own token and deletes the file while the other keeps running.
  //
  // Not stealing costs a bounded wait. Stealing costs a corrupted state
  // directory, so an unconfirmable live owner must get the same grace window a
  // failed `ps` already gets.
  // Driven through the REAL classifier and a REAL live pid — this process —
  // because the bug is in the classifier, not in how acquire treats its
  // answer. `ps` genuinely runs; the command line it prints for vitest cannot
  // contain the recorded argv0, which is exactly the shape of an app whose
  // bundle moved or was replaced in place while running.
  const liveButUnconfirmable = {
    pid: process.pid,
    argv0: '/Applications/Agent Code.app/Contents/MacOS/Agent Code',
    token: 'incumbent',
  }

  it('does not take the lock from a live pid it cannot confirm', async () => {
    await writeOwner({ ...liveButUnconfirmable, startedAt: new Date().toISOString() })
    const lock = await acquireStateProcessLock({ stateDir, pid: 100, argv0: '/apps/Agent Code' })
    expect(lock).toMatchObject({ acquired: false, reason: 'active-owner' })
    // The incumbent's file is still its own. Overwriting it is what leaves the
    // incumbent unable to clean up after itself later.
    const still = JSON.parse(await readFile(lockPath, 'utf8')) as StateProcessLockOwner
    expect(still.token).toBe('incumbent')
  })

  it('still self-heals once such a lock is old, so PID reuse cannot lock anyone out', async () => {
    await writeOwner({ ...liveButUnconfirmable, startedAt: new Date('2026-09-18T10:00:00Z').toISOString() })
    const lock = await acquireStateProcessLock({
      stateDir,
      pid: 100,
      argv0: '/apps/Agent Code',
      now: at('2026-09-18T10:30:00Z'),
    })
    expect(lock.acquired).toBe(true)
  })

  it('takes over immediately when the pid is really gone', async () => {
    // The distinction that has to survive: a DEAD owner costs nothing to
    // clean up, and making every stale lock wait five minutes would turn a
    // crash into a five-minute outage.
    await writeOwner({ pid: 0x7ffffffe, startedAt: new Date().toISOString() })
    const lock = await acquireStateProcessLock({ stateDir, pid: 100, argv0: '/apps/Agent Code' })
    expect(lock.acquired).toBe(true)
  })
})

describe('release is owner-scoped', () => {
  it('removes only its own lock', async () => {
    const lock = await acquireStateProcessLock({ stateDir, pid: 100 })
    if (!lock.acquired) throw new Error('expected the lock')
    await lock.release()
    expect(existsSync(lockPath)).toBe(false)
  })

  it('leaves a successor\'s lock alone', async () => {
    // The state #993 ends in: someone took over, and the original owner is
    // shutting down. Deleting here would leave the successor unprotected.
    const lock = await acquireStateProcessLock({ stateDir, pid: 100 })
    if (!lock.acquired) throw new Error('expected the lock')
    await writeOwner({ token: 'someone-else', pid: 200 })
    await lock.release()
    expect(existsSync(lockPath)).toBe(true)
    expect((JSON.parse(await readFile(lockPath, 'utf8')) as StateProcessLockOwner).pid).toBe(200)
  })

  it('does the same synchronously, which is the crash path', async () => {
    const lock = await acquireStateProcessLock({ stateDir, pid: 100 })
    if (!lock.acquired) throw new Error('expected the lock')
    await writeOwner({ token: 'someone-else', pid: 200 })
    lock.releaseSync()
    expect(existsSync(lockPath)).toBe(true)
  })
})

describe('a half-written lock is not treated as free', () => {
  it('refuses a fresh unparseable lock, which is the create/write window', async () => {
    // `open(..., 'wx')` creates the file before the JSON body is written. A
    // sibling that reads that instant must not call it stale.
    await writeFile(lockPath, '', 'utf8')
    const lock = await acquireStateProcessLock({ stateDir, pid: 100 })
    expect(lock).toMatchObject({ acquired: false, reason: 'unreadable-lock' })
  })

  it('clears an unparseable lock that has been there for ages', async () => {
    await writeFile(lockPath, 'not json', 'utf8')
    const lock = await acquireStateProcessLock({
      stateDir, pid: 100,
      now: () => new Date(Date.now() + 10 * 60 * 1000),
    })
    expect(lock.acquired).toBe(true)
  })
})
