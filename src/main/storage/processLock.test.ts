import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { acquireStateProcessLock, classifyLockOwner, LINK_UNSUPPORTED_CODES } from './processLock.js'
import type { LockOwnerProbe, StateProcessLockOwner } from './processLock.js'

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

describe('classifying the recorded owner (#993)', () => {
  // Driven through the exported `classifyLockOwner` because every branch is a
  // different kind of evidence and the interesting ones need a world this
  // machine does not have: a live pid whose command line does not match, a
  // recycled pid, a `ps` that refuses to answer. Injecting the probe makes all
  // of them reachable without coupling the suite to the checkout's path — an
  // earlier version drove the real classifier against the vitest pid and would
  // have flipped had the repository lived under a directory named "Agent Code".
  const owner: StateProcessLockOwner = {
    token: 'incumbent',
    pid: 4242,
    startedAt: '2026-09-18T10:00:00.000Z',
    argv0: '/Applications/Agent Code.app/Contents/MacOS/Agent Code',
  }
  const probe = (over: Partial<LockOwnerProbe> = {}): LockOwnerProbe => ({
    isPidRunning: () => true,
    commandLineForPid: () => '/Applications/Agent Code.app/Contents/MacOS/Agent Code',
    processStartedAtMs: () => Date.parse('2026-09-18T09:59:59.000Z'),
    ...over,
  })
  const ms = (iso: string) => Date.parse(iso)

  it('a dead pid is free', () => {
    expect(classifyLockOwner(owner, probe({ isPidRunning: () => false }))).toBe('inactive')
  })

  it('a live pid still advertising the recorded executable is the owner', () => {
    expect(classifyLockOwner(owner, probe())).toBe('active')
  })

  // Each of these is asserted against a start time that would say 'inactive'
  // on its own, so the command-line match is what decides the answer. Probing
  // with a start time that already implies 'active' would let the whole match
  // be deleted with the suite still green.
  const looksRecycled = { processStartedAtMs: () => ms('2026-09-18T11:00:00.000Z') }

  it('matches the recorded executable however the argv is rendered', () => {
    expect(classifyLockOwner(owner, probe({
      ...looksRecycled,
      commandLineForPid: () => `${owner.argv0} --enable-features=X`,
    }))).toBe('active')
  })

  it('matches on the basename when the path has moved', () => {
    // The bundle running from a different directory is still the same app.
    expect(classifyLockOwner(owner, probe({
      ...looksRecycled,
      commandLineForPid: () => '/Volumes/Install/Agent Code.app/Contents/MacOS/Agent Code',
    }))).toBe('active')
  })

  it('treats an empty recorded argv0 as unmatchable rather than as a mismatch', () => {
    // `process.argv[0]` can be absent; refusing to decide on no evidence is
    // not the same as deciding the owner is gone.
    expect(classifyLockOwner({ ...owner, argv0: '' }, probe({
      ...looksRecycled,
      commandLineForPid: () => 'something else entirely',
    }))).toBe('active')
  })

  // ── THE #993 CASE ──
  // A live pid whose command line does not match is NOT evidence the owner is
  // gone. The bundle may have been replaced in place by an update, renamed or
  // moved. Stealing here puts two mains on one state directory.
  const mismatched = probe({ commandLineForPid: () => '/opt/homebrew/bin/some-other-process' })

  it('keeps the lock when the live pid started BEFORE it — that is the owner', () => {
    // A process cannot have started after the lock its own acquisition wrote,
    // so this is the incumbent however its command line now reads. No grace
    // window is involved: the answer is exact and permanent.
    expect(classifyLockOwner(owner, { ...mismatched, processStartedAtMs: () => ms('2026-09-18T09:00:00.000Z') }))
      .toBe('active')
  })

  it('does not care how OLD such a lock is', () => {
    // The first attempt at this fix routed the mismatch into the five-minute
    // grace window, which is measured from the lock's `startedAt` — the
    // incumbent's UPTIME. Every reason for a mismatch is permanent for the
    // life of that process, so anything older than five minutes was stolen
    // from exactly as before, and five minutes of uptime is nothing.
    expect(classifyLockOwner(
      { ...owner, startedAt: '2020-01-01T00:00:00.000Z' },
      { ...mismatched, processStartedAtMs: () => ms('2019-12-31T23:00:00.000Z') },
    )).toBe('active')
  })

  it('frees a lock whose pid started AFTER it — that is a recycled number', () => {
    expect(classifyLockOwner(owner, { ...mismatched, processStartedAtMs: () => ms('2026-09-18T11:00:00.000Z') }))
      .toBe('inactive')
  })

  it('tolerates a start time a shade later than the lock it wrote', () => {
    // `lstart` rounds to the second and the two clocks are read at different
    // moments, so the owner can look marginally younger than its own lock.
    expect(classifyLockOwner(owner, { ...mismatched, processStartedAtMs: () => ms('2026-09-18T10:00:01.000Z') }))
      .toBe('active')
  })

  it('falls back to the bounded window when neither question can be answered', () => {
    expect(classifyLockOwner(owner, probe({
      commandLineForPid: () => null,
      processStartedAtMs: () => null,
    }))).toBe('inconclusive')
    // …and when the lock's own timestamp is unusable.
    expect(classifyLockOwner({ ...owner, startedAt: 'not a date' }, mismatched)).toBe('inconclusive')
  })
})

describe('an unconfirmable live owner gets a bounded window, and only a bounded one', () => {
  it('refuses while the window is open', () => {
    // The guard itself. Nothing else pins this from BELOW: shrinking the
    // window to a second would otherwise ship green.
    const lock = acquireStateProcessLock({
      stateDir, pid: 100, now: at('2026-09-18T10:04:00Z'), isLockOwnerActive: () => 'inconclusive',
    })
    return writeOwner({ startedAt: '2026-09-18T10:00:00.000Z' })
      .then(() => lock)
      .then(result => expect(result).toMatchObject({ acquired: false, reason: 'active-owner' }))
  })

  it('takes over once it has expired', async () => {
    await writeOwner({ startedAt: '2026-09-18T10:00:00.000Z' })
    const lock = await acquireStateProcessLock({
      stateDir, pid: 100, now: at('2026-09-18T10:30:00Z'), isLockOwnerActive: () => 'inconclusive',
    })
    expect(lock.acquired).toBe(true)
  })

  it('opens even when the lock claims a FUTURE start time', async () => {
    // A clock corrected backwards leaves `startedAt` ahead of now. A negative
    // age is below every threshold forever, so the window never opened and the
    // user had to delete a JSON file by hand to launch.
    await writeOwner({ startedAt: '2030-01-01T00:00:00.000Z' })
    const lock = await acquireStateProcessLock({
      stateDir, pid: 100, now: at('2026-09-18T10:00:00Z'), isLockOwnerActive: () => 'inconclusive',
    })
    expect(lock.acquired).toBe(true)
  })
})

describe('two launches over ONE stale lock (#1094)', () => {
  // The failure this file exists to prevent, reached through the CLEANUP path
  // rather than through the lock itself.
  //
  // The EEXIST branch ended in an unconditional `rm(lockPath)`. Two launches
  // that both find the same stale lock both reach it, and the second delete
  // removes the FIRST one's freshly created lock — so its `open(..., 'wx')`
  // succeeds too and both calls return `acquired: true`. That is two mains on
  // one state directory: #993, the corruption this lock was added to close.
  //
  // `release` already refuses to unlink a file whose token is not its own, and
  // its comment says exactly why ("blindly unlinking would reopen the exact
  // multi-main-process window this file is supposed to close"). The cleanup
  // path did not follow its own rule.

  const DEAD_PID = 4242

  async function writeStaleOwner(): Promise<void> {
    // A lock whose owner is long dead: old enough to be past every grace
    // window, so classification is unambiguous and both racers agree it is
    // stale. That agreement is the precondition for the race.
    await writeFile(lockPath, `${JSON.stringify({
      token: 'dead-owner', pid: DEAD_PID,
      startedAt: '2020-01-01T00:00:00.000Z',
      argv0: '/dead/Electron',
    }, null, 2)}\n`, 'utf8')
  }

  let nextRacerPid = 0
  // The probe answers the way the real `classifyLockOwner` does, per OWNER:
  // the recorded dead pid is dead, and a racer that has just written its own
  // lock is alive. A blanket `() => 'inactive'` would be a different test —
  // every racer would keep stealing every other racer's FRESH lock, which is
  // not a state production can reach and would make the fix untestable.
  const acquire = () => acquireStateProcessLock({
    stateDir,
    pid: 101 + (nextRacerPid++),
    isLockOwnerActive: owner => (owner.pid === DEAD_PID ? 'inactive' : 'active'),
  })

  it.each([2, 4, 8])('leaves exactly ONE of %d concurrent launches holding it', async racers => {
    // The contract acquisition can actually promise, stated as it is rather
    // than as one would like it:
    //
    // Two launches that condemn the same corpse BOTH replace it — `rename` is
    // atomic but it is not create-if-absent — and each can read back its own
    // token if it reads before the other's rename lands. So the answer
    // `acquired: true` is provisional for exactly this case, and the file
    // settles on one of them a moment later. `revalidate()` is what turns that
    // into something a caller can act on, and `index.ts` calls it before this
    // process writes anything.
    //
    // What is NOT provisional, and is the whole point: nobody's file is ever
    // deleted, the path is never empty, and the survivor is whoever the
    // filesystem says it is.
    await writeStaleOwner()

    const results = await Promise.all(Array.from({ length: racers }, () => acquire()))

    const held = results.filter(result => result.acquired)
    expect(held.length).toBeGreaterThan(0)
    const survivors = held.filter(result => result.acquired && result.revalidate())
    expect(survivors).toHaveLength(1)
    // Every launch that lost can TELL it lost. Before this, a loser's handle
    // was indistinguishable from a winner's and its release was a silent
    // no-op, so the end state was a live writer and no lock file at all.
    for (const result of held) {
      if (result === survivors[0]) continue
      expect(result.acquired && result.revalidate()).toBe(false)
    }
    const onDisk = JSON.parse(await readFile(lockPath, 'utf8')) as StateProcessLockOwner
    expect(onDisk.token).toBe((survivors[0] as { token: string }).token)
  })

  it('never leaves the lock path empty, even mid-takeover', async () => {
    // The property that made the previous design's three-way race possible: a
    // steal that moved the corpse aside left a hole for two syscalls, and a
    // third launch published into it. A replace has no hole — so a watcher
    // that reads continuously sees a valid lock at every instant from the
    // first publish onward.
    await writeStaleOwner()
    const observed: Array<string | null> = []
    let watching = true
    const watch = (): void => {
      if (!watching) return
      try { observed.push(readFileSync(lockPath, 'utf8')) } catch { observed.push(null) }
      setImmediate(watch)
    }
    setImmediate(watch)

    await Promise.all([acquire(), acquire(), acquire(), acquire()])
    watching = false

    expect(observed.length).toBeGreaterThan(0)
    expect(observed.filter(content => content === null)).toEqual([])
    for (const content of observed) {
      expect(() => JSON.parse(content!) as unknown).not.toThrow()
    }
  })

  it('refuses, and leaves the file alone, when another launch wins while this one is classifying', async () => {
    // THE deterministic version of the race, modelled where it actually
    // happens. Classification is the slow step — it runs `ps`, synchronously —
    // so the window a sibling wins in is the window this call is inside its
    // own probe. Writing the sibling's lock from the probe reproduces that
    // ordering exactly, instead of hoping two in-process acquisitions
    // interleave (they do, about 10 times in 200, which is a test that passes
    // for the wrong reason 190 times).
    //
    // What the old code did here: it came back from classification, deleted
    // the path unconditionally — destroying the sibling's live lock — and
    // created its own. Two mains, one state directory: #993.
    await writeStaleOwner()
    const sibling = { token: 'sibling-token', pid: 777, startedAt: new Date().toISOString(), argv0: '/live/Electron' }

    const lock = await acquireStateProcessLock({
      stateDir,
      pid: 101,
      isLockOwnerActive: owner => {
        if (owner.pid === DEAD_PID) {
          // The sibling finishes acquiring while we are still deciding about
          // the corpse we both found.
          writeFileSync(lockPath, `${JSON.stringify(sibling, null, 2)}\n`, 'utf8')
          return 'inactive'
        }
        return 'active'
      },
    })

    expect(lock.acquired).toBe(false)
    // The sibling's lock is untouched: same token, still there.
    const onDisk = JSON.parse(await readFile(lockPath, 'utf8')) as StateProcessLockOwner
    expect(onDisk.token).toBe('sibling-token')
  })

  it('never publishes a lock that another launch can observe EMPTY', async () => {
    // The other half of the same double-acquire, from the other direction: a
    // lock created with `open(..., 'wx')` and written afterwards exists, for a
    // moment, with no content. A sibling that reads it in that window sees a
    // malformed lock — and a malformed lock is a thing this function breaks.
    //
    // Publishing by `link` from a fully written staging file removes the
    // window rather than guarding it: the first byte anyone can see is the
    // finished JSON.
    const observed: string[] = []
    let watching = true
    const watch = (): void => {
      if (!watching) return
      try { observed.push(readFileSync(lockPath, 'utf8')) } catch { /* not there yet */ }
      setImmediate(watch)
    }
    setImmediate(watch)

    const lock = await acquireStateProcessLock({ stateDir, pid: 101 })
    watching = false

    expect(lock.acquired).toBe(true)
    // And the staging file it published through is gone. `link` leaves the
    // source behind (two names, one inode), so unlike the replace path this
    // one has something to clean up — one corpse per launch otherwise.
    expect((await readdir(stateDir)).filter(name => name !== 'agent-code.process-lock.json')).toEqual([])
    // The watcher has to have run during the acquisition, or this proves
    // nothing at all.
    expect(observed.length).toBeGreaterThan(0)
    expect(observed.filter(content => content.trim().length === 0)).toEqual([])
    for (const content of observed) {
      expect(() => JSON.parse(content) as unknown).not.toThrow()
    }
  })

  it('refuses a lock path it can neither read nor date, instead of breaking it', async () => {
    // `invalidAgeMs` is null when the read failed and the age could not be
    // established — a vanished file, a permission problem, or (as here) a path
    // that is not a regular file at all. That used to fall THROUGH to the
    // break-the-lock branch, so "I could not tell how old this is" was treated
    // as "it is old", and the next step deleted it.
    //
    // Breaking a lock we cannot date is the one thing this function must never
    // do: refusing costs a relaunch, and the alternative costs the state
    // directory.
    await mkdir(join(stateDir, 'agent-code.process-lock.json'))

    const lock = await acquireStateProcessLock({ stateDir, pid: 101 })

    expect(lock).toMatchObject({ acquired: false, reason: 'unreadable-lock' })
    // And it is still there: nothing was destroyed on the way out.
    expect(existsSync(lockPath)).toBe(true)
  })

  it('still cleans a stale lock up, so a dead owner cannot refuse every launch', async () => {
    // The control. "Never delete anything" would satisfy both cases above and
    // brick the app after a crash: the user would have to delete a JSON file
    // by hand to launch again.
    await writeStaleOwner()

    const lock = await acquire()

    expect(lock.acquired).toBe(true)
    // No leftovers beside it: a steal that renames the stale file must also
    // clear what it renamed, or STATE_DIR accumulates one corpse per launch.
    const leftovers = (await readdir(stateDir)).filter(name => name !== 'agent-code.process-lock.json')
    expect(leftovers).toEqual([])
  })

  it('never deletes a lock it did not write, over many rounds', async () => {
    // One pass of a race proves nothing. What is asserted is the invariant
    // that survives every ordering — the file is always there, always valid,
    // and always names exactly one live holder.
    for (let round = 0; round < 25; round += 1) {
      await rm(lockPath, { force: true })
      await writeStaleOwner()

      const results = await Promise.all([acquire(), acquire()])

      expect(existsSync(lockPath)).toBe(true)
      const survivors = results.filter(result => result.acquired && result.revalidate())
      expect(survivors).toHaveLength(1)
    }
  })

  it('reports the lock LOST when its file is gone', async () => {
    // `revalidate` answering "still ours" for a missing file would make the
    // one safety check this handle offers lie in the exact case it exists for:
    // nothing that participates correctly removes somebody else's lock, so a
    // vanished file means the assumption underneath this process is broken.
    const lock = await acquireStateProcessLock({ stateDir, pid: 100 })
    if (!lock.acquired) throw new Error('expected the lock')
    expect(lock.revalidate()).toBe(true)

    await rm(lockPath, { force: true })

    expect(lock.revalidate()).toBe(false)
  })

  it('reports the lock LOST when another launch has replaced it', async () => {
    const lock = await acquireStateProcessLock({ stateDir, pid: 100 })
    if (!lock.acquired) throw new Error('expected the lock')

    await writeOwner({ token: 'someone-else', pid: 200 })

    expect(lock.revalidate()).toBe(false)
  })

  it('knows the errno macOS actually returns when a filesystem has no hard links', () => {
    // The branch itself needs a FAT volume to exercise, so what is pinned is
    // the LIST, which is the part that was wrong: on Darwin `ENOTSUP` (45) and
    // `EOPNOTSUPP` (102) are different values and `ENOTSUP` is the one that
    // happens. Without it the fallback never fired, the error escaped
    // `index.ts`'s startup guard, and the app died with no dialog on any home
    // directory that is not on APFS or ext4.
    expect(LINK_UNSUPPORTED_CODES).toContain('ENOTSUP')
    expect(LINK_UNSUPPORTED_CODES).toContain('EOPNOTSUPP')
    // Linux vfat.
    expect(LINK_UNSUPPORTED_CODES).toContain('EPERM')
    // EEXIST must NOT be here: that is a lock somebody else holds, and
    // treating it as "no hard links" would fall back into creating one on top.
    expect(LINK_UNSUPPORTED_CODES).not.toContain('EEXIST')
  })

  it('gives up after a bounded number of losses instead of spinning', async () => {
    // A launch that keeps losing the replace must stop. The bound is what
    // makes that true, and nothing exercised it: the suite pinned "at least
    // one retry", so the value itself was free to change.
    //
    // The probe writes a fresh foreign lock every time it is asked — a rival
    // that wins every round — so every attempt condemns a corpse, replaces it,
    // and reads back somebody else's token.
    let classifications = 0
    await writeStaleOwner()

    const lock = await acquireStateProcessLock({
      stateDir,
      pid: 101,
      isLockOwnerActive: () => {
        classifications += 1
        writeFileSync(lockPath, `${JSON.stringify({
          token: `rival-${classifications}`, pid: 900 + classifications,
          startedAt: '2020-01-01T00:00:00.000Z', argv0: '/rival/Electron',
        }, null, 2)}\n`, 'utf8')
        return 'inactive'
      },
    })

    expect(lock.acquired).toBe(false)
    // Three attempts: the first plus MAX_STALE_RETRIES.
    expect(classifications).toBe(3)
  })

  it('refuses a lock file it can read but not date, and says where it is', async () => {
    // A lock whose bytes are unreadable can never be dated, so a refusal that
    // waits for it to age out waits forever. Review found the first version of
    // this guard turned that into a PERMANENT "Agent Code is already running"
    // with the path only in a console warning — worse than the behaviour it
    // replaced. The refusal is right; it just has to be the kind the caller
    // can explain, which is why `reason` carries it.
    await writeFile(lockPath, 'not json at all\n', 'utf8')

    // No `now` override: the file's age is what it really is (about zero), so
    // this is the "fresh and malformed" case the guard is for, not a
    // future-dated one.
    const lock = await acquireStateProcessLock({ stateDir, pid: 100 })

    expect(lock).toMatchObject({ acquired: false, reason: 'unreadable-lock', path: lockPath })
  })

  it('refuses a lock path that is a dangling symlink, rather than writing through it', async () => {
    // Not the vanished-mid-read case — that one is a genuine race I cannot
    // construct in-process, and it is handled by going round rather than
    // refusing (an ordinary release landing in that gap must not fail a
    // launch). This is its observable cousin: a path that EXISTS to the atomic
    // create and reads as nothing at all.
    //
    // It refuses, which is the right answer: following or replacing a symlink
    // somebody put there would write the lock somewhere else entirely.
    await symlink(join(stateDir, 'nowhere.json'), lockPath)

    const lock = await acquireStateProcessLock({ stateDir, pid: 100 })

    expect(lock.acquired).toBe(false)
    expect(lstatSync(lockPath).isSymbolicLink()).toBe(true)
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

  it('gives each acquisition a distinct token, so a stale release cannot fire', async () => {
    // The real sequence: A exits and releases, B launches and acquires, and
    // only THEN does a late `releaseSync` from A run. With a constant token
    // that late call would match B's lock and delete it, leaving B running
    // unprotected — which is the state #993 reports.
    const first = await acquireStateProcessLock({ stateDir, pid: 100 })
    if (!first.acquired) throw new Error('expected the lock')
    await first.release()
    const second = await acquireStateProcessLock({ stateDir, pid: 200 })
    if (!second.acquired) throw new Error('expected the lock')
    expect(second.token).not.toBe(first.token)

    first.releaseSync()
    expect(existsSync(lockPath)).toBe(true)
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
  it('still treats a lock a few seconds ahead of the clock as fresh', async () => {
    // Filesystem mtimes carry sub-millisecond precision that `Date.now()` does
    // not, so the freshest possible lock — the one being written during the
    // create/write race — can read as a hair in the future. Without a jitter
    // margin, treating "future" as "infinitely old" would delete exactly that.
    await writeFile(lockPath, '', 'utf8')
    const soon = new Date(Date.now() + 5_000)
    await utimes(lockPath, soon, soon)
    expect(await acquireStateProcessLock({ stateDir, pid: 100 }))
      .toMatchObject({ acquired: false, reason: 'unreadable-lock' })
  })

  it('does not block forever on a garbage lock with a FUTURE mtime', async () => {
    // Needs no live pid at all: a lock file restored from a backup with a
    // future mtime used to block startup indefinitely, because a negative age
    // is below every staleness threshold.
    await writeFile(lockPath, 'not json', 'utf8')
    await utimes(lockPath, new Date('2030-01-01T00:00:00Z'), new Date('2030-01-01T00:00:00Z'))
    expect((await acquireStateProcessLock({ stateDir, pid: 100 })).acquired).toBe(true)
  })

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
