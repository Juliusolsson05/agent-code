import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { link, open, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { STATE_DIR } from '@main/storage/paths.js'

const LOCK_FILE_NAME = 'agent-code.process-lock.json'
const INVALID_LOCK_STALE_MS = 5 * 60 * 1000
const INCONCLUSIVE_OWNER_STALE_MS = 5 * 60 * 1000
const MAX_STALE_RETRIES = 2

/**
 * The errno values that mean "this filesystem has no hard links", so the
 * `link` publish must fall back to create-then-write.
 *
 * Exported because the LIST is the thing that was wrong and the branch itself
 * cannot be exercised without mounting a FAT volume: on Darwin `ENOTSUP` (45)
 * and `EOPNOTSUPP` (102) are different errno values, and `ENOTSUP` is the one
 * macOS actually returns — review proved it on a real FAT32 image. The first
 * version of this list caught the one that never happens, so the fallback
 * never fired, the error escaped `index.ts`'s EACCES/EROFS/EPERM/ENOSPC/EDQUOT
 * guard, and the app died at startup with no dialog. Linux vfat returns
 * `EPERM`, which is why that entry was right by luck.
 */
export const LINK_UNSUPPORTED_CODES = ['EPERM', 'ENOSYS', 'EXDEV', 'EOPNOTSUPP', 'ENOTSUP'] as const
const CLOCK_JITTER_TOLERANCE_MS = 60 * 1000

export type StateProcessLockOwner = {
  token: string
  pid: number
  startedAt: string
  argv0: string
}

type AcquireOptions = {
  stateDir?: string
  pid?: number
  argv0?: string
  now?: () => Date
  isLockOwnerActive?: (owner: StateProcessLockOwner) => boolean | LockOwnerActivity
}

type LockOwnerActivity = 'active' | 'inactive' | 'inconclusive'

export type StateProcessLock =
  | {
      acquired: true
      path: string
      token: string
      /**
       * Does this process STILL hold the lock it was given (#1094)?
       *
       * Acquisition cannot promise a single winner in every ordering: two
       * launches that condemn the same stale lock both replace it, and each
       * can read back its own token if it reads before the other's rename
       * lands. The file settles on one of them a moment later, and the loser
       * has no idea — it was told `acquired: true` and never looks again.
       *
       * This is that second look. Cheap (one read, one comparison), and the
       * caller decides what to do: refusing to write state and quitting is a
       * recoverable inconvenience, while two mains writing one state directory
       * is the corruption this whole file exists to prevent (#993).
       */
      revalidate: () => boolean
      release: () => Promise<void>
      releaseSync: () => void
    }
  | {
      acquired: false
      path: string
      owner: StateProcessLockOwner | null
      reason: 'active-owner' | 'unreadable-lock'
    }

// Exported (not only used as the lock's default) because the mitmproxy reaper
// (src/main/proxy/mitmproxyReaper.ts) needs the same liveness answer with the
// same EPERM semantics: a pid we cannot signal is still an owner we must not
// clean up after. One definition keeps the two callers from disagreeing.
export function isPidRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // EPERM means the process exists but this user cannot signal it.
    // For lock purposes that is still an active owner; deleting its lock would
    // be exactly the cross-process stomp this guard exists to prevent.
    return code === 'EPERM'
  }
}

function commandLineForPid(pid: number): string | null {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

/**
 * When the kernel says that pid started, in epoch milliseconds.
 *
 * `LC_ALL=C` because the format is parsed, not displayed — `mitmproxyReaper`
 * pins the same locale for the same `lstart` field and for the same reason.
 * `lstart` has one-second resolution, which is all this needs.
 */
function processStartedAtMs(pid: number): number | null {
  try {
    const raw = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' },
    }).trim()
    if (raw.length === 0) return null
    const parsed = Date.parse(raw)
    return Number.isFinite(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * The ports the classifier reads the world through. Injected so every branch
 * can be driven in a test — including the ones that need a pid, a command line
 * or a process start time this machine does not happen to have.
 */
export type LockOwnerProbe = {
  isPidRunning(pid: number): boolean
  commandLineForPid(pid: number): string | null
  processStartedAtMs(pid: number): number | null
}

const REAL_PROBE: LockOwnerProbe = { isPidRunning, commandLineForPid, processStartedAtMs }

/**
 * `lstart` rounds to the second and the two clocks are read at different
 * moments, so a process that acquired the lock in its first instant can look a
 * shade younger than its own lock. Only a gap larger than this counts as
 * evidence of a DIFFERENT process wearing the same pid.
 */
const PID_REUSE_TOLERANCE_MS = 2_000

/**
 * Is the process named in this lock still the one that wrote it?
 *
 * Exported so the decision can be driven directly; every branch here is a
 * different kind of evidence and each one changes what happens to a live
 * process's state directory.
 */
export function classifyLockOwner(
  owner: StateProcessLockOwner,
  probe: LockOwnerProbe = REAL_PROBE,
): LockOwnerActivity {
  // The pid is gone. Nothing to protect; the lock is free.
  if (!probe.isPidRunning(owner.pid)) return 'inactive'

  const commandLine = probe.commandLineForPid(owner.pid)
  if (commandLine !== null) {
    // WHY a PID liveness check is not enough:
    //
    // Lock files intentionally survive crashes so the next launch can decide
    // whether the recorded owner is still alive. PIDs are recycled, though; a
    // random unrelated process can inherit the old number after reboot and make
    // `kill(pid, 0)` succeed forever. The command-line check is not a security
    // boundary, but a live Agent Code/Electron owner still advertises the
    // executable that wrote the lock, while a recycled PID almost certainly
    // does not.
    //
    // Matched on the BASENAME alone, which is not a loosening: any command
    // line containing the full `argv0` necessarily contains its basename, and
    // an empty `argv0` yields an empty basename that `includes` accepts from
    // every string. The two extra clauses this used to carry could never be
    // the deciding one — mutation testing found both unreachable — and a
    // condition that cannot change an answer is a condition the next reader
    // has to disprove.
    if (commandLine.includes(basename(owner.argv0))) return 'active'
  }

  // ── LIVE PID, NO MATCH: ASK THE KERNEL INSTEAD OF GUESSING (#993) ──
  //
  // This used to answer 'inactive' — delete the file and take over. But the
  // only thing that failed is a STRING MATCH against a command line, and there
  // are ordinary reasons for that to fail while the owner is very much alive
  // and writing: the bundle was replaced in place by an update, the app was
  // renamed or moved, a dev binary lives at a path that has since changed, or
  // `ps` rendered the argv differently than `process.argv[0]` spelled it.
  //
  // A first attempt at this routed the mismatch into the 'inconclusive' grace
  // window below. Review showed that does almost nothing: the window is
  // measured from the lock's `startedAt`, which is the incumbent's UPTIME, and
  // every reason for the mismatch is permanent for the life of that process.
  // So anything older than five minutes was stolen from exactly as before, and
  // five minutes of uptime is nothing.
  //
  // Why it matters more than "two apps run at once": once the incumbent's lock
  // has been overwritten, the file carries the SUCCESSOR's token. The
  // incumbent's own release no longer matches and is a silent no-op, while the
  // successor's release deletes the file although the incumbent is still
  // running — so the state directory ends up with a live writer and no lock at
  // all. That is the state #993 reports, though not precisely the moment it
  // reports: that snapshot has both mains live AND the file already gone, so
  // this is one way to reach it rather than a proven account of the incident.
  //
  // There is no need to guess at all. The question the heuristic was groping
  // for is "is this pid the process that wrote the lock, or a recycled number
  // wearing it?", and the kernel answers it exactly: a process cannot have
  // started AFTER the lock that its own acquisition wrote. So a start time
  // later than `startedAt` is a reused pid and nothing else, while a start
  // time at or before it is the genuine owner, however its command line now
  // reads.
  const lockWrittenAtMs = Date.parse(owner.startedAt)
  const startedAtMs = probe.processStartedAtMs(owner.pid)
  if (startedAtMs !== null && Number.isFinite(lockWrittenAtMs)) {
    return startedAtMs > lockWrittenAtMs + PID_REUSE_TOLERANCE_MS ? 'inactive' : 'active'
  }

  // Neither `ps` query answered, or the lock carries no usable timestamp. The
  // pid IS alive, so this is the one genuinely unknown case, and it gets the
  // bounded window below rather than a takeover.
  return 'inconclusive'
}

function normalizeLockOwnerActivity(value: boolean | LockOwnerActivity): LockOwnerActivity {
  if (value === true) return 'active'
  if (value === false) return 'inactive'
  return value
}

function parseLock(raw: string): StateProcessLockOwner | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StateProcessLockOwner>
    if (
      typeof parsed.token !== 'string' ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.startedAt !== 'string' ||
      typeof parsed.argv0 !== 'string'
    ) {
      return null
    }
    return {
      token: parsed.token,
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      argv0: parsed.argv0,
    }
  } catch {
    return null
  }
}

/**
 * How old something is, where a timestamp FROM THE FUTURE counts as infinitely
 * old rather than infinitely young.
 *
 * ── WHY NOT JUST CLAMP TO ZERO (#1072 review, finding 5b) ──
 * A clock corrected backwards — bad RTC, VM snapshot restore, a dual-boot
 * machine treating the RTC as local time — leaves a recorded time ahead of
 * `now`. Subtracting gives a NEGATIVE age, which is below every threshold, so
 * the grace window never opens and the user has to delete a JSON file by hand
 * to launch. Clamping to zero does not fix that: the age stays pinned at zero
 * until the real clock catches up, which may be years.
 *
 * A timestamp that cannot have happened yet is not evidence of freshness, and
 * the entire point of these windows is that they are BOUNDED. So an
 * impossible time makes the lock immediately eligible for cleanup.
 *
 * That is safe here because it is no longer load-bearing for a live owner:
 * `classifyLockOwner` answers 'active' for a real incumbent from the kernel's
 * process start time, with no window involved. Reaching this with a live pid
 * now requires `ps` to answer nothing at all AND the timestamp to be corrupt —
 * and between a permanent lockout and a bounded takeover in that corner, the
 * bounded one is the lesser harm.
 */
function ageFrom(basisMs: number, now: () => Date): number {
  const age = now().getTime() - basisMs
  // The tolerance is not cosmetic. A file's mtime carries sub-millisecond
  // precision that `Date.now()` does not, so a lock written microseconds ago
  // can read as a hair in the future — and without a margin that would make
  // the freshest possible lock, the one being written RIGHT NOW in the
  // create/write race, instantly eligible for deletion. A minute is far beyond
  // any filesystem or scheduling jitter and far below any real clock skew.
  return age < -CLOCK_JITTER_TOLERANCE_MS ? Number.POSITIVE_INFINITY : Math.max(0, age)
}

async function readExistingLock(
  lockPath: string,
  now: () => Date,
): Promise<{
  owner: StateProcessLockOwner | null
  ownerAgeMs: number | null
  invalidAgeMs: number | null
  /**
   * The path holds something we could not read (#1094 review).
   *
   * Distinguished from "gone" because the two need opposite answers and used
   * to share one: a lock that VANISHED between the failed create and this read
   * is nobody's, and the next atomic create settles it; a lock that is present
   * and unreadable — wrong ownership after a migration or a restore, the
   * scenario `index.ts` already names — must be refused, and its age can never
   * be established, so a refusal that waits for it to "age out" waits forever.
   */
  unreadable: boolean
  /** Exactly what was read, so the caller can prove the file has not changed
   *  since it was classified. */
  raw: string | null
}> {
  const [raw, fileStat] = await Promise.all([
    readFile(lockPath, 'utf8').catch(() => null),
    stat(lockPath).catch(() => null),
  ])
  if (raw === null) {
    return { owner: null, ownerAgeMs: null, invalidAgeMs: null, unreadable: fileStat !== null, raw: null }
  }
  const owner = parseLock(raw)
  if (owner) {
    const startedAtMs = Date.parse(owner.startedAt)
    const ageBaseMs = Number.isFinite(startedAtMs)
      ? startedAtMs
      : fileStat?.mtimeMs
    return {
      owner,
      ownerAgeMs: ageBaseMs === undefined ? null : ageFrom(ageBaseMs, now),
      invalidAgeMs: null,
      unreadable: false,
      raw,
    }
  }
  if (!fileStat) return { owner: null, ownerAgeMs: null, invalidAgeMs: null, unreadable: false, raw }
  return { owner: null, ownerAgeMs: null, invalidAgeMs: ageFrom(fileStat.mtimeMs, now), unreadable: false, raw }
}

/**
 * The handle a successful acquisition returns.
 *
 * Extracted because there are now three ways to end up holding it — the
 * `link` publish, the `open(..., 'wx')` fallback for filesystems without hard
 * links, and replacing a stale lock by rename — and a release or a
 * revalidation that differed between them would be a lock whose safety
 * depended on how it was acquired.
 */
function heldLock(lockPath: string, token: string): StateProcessLock {
  return {
    acquired: true,
    path: lockPath,
    token,
    revalidate: () => {
      try {
        return parseLock(readFileSync(lockPath, 'utf8'))?.token === token
      } catch {
        // Unreadable or gone. Gone is the interesting one: it means something
        // removed our lock, which no correct participant does — so this is NOT
        // treated as "still ours". Answering false makes a caller act on a
        // state it can act on; answering true would make the one safety check
        // this handle offers lie in the exact case it exists for.
        return false
      }
    },
    releaseSync: () => {
      try {
        const existing = parseLock(readFileSync(lockPath, 'utf8'))
        if (existing?.token === token) {
          rmSync(lockPath, { force: true })
        }
      } catch {
        // Missing/unreadable at shutdown means another cleanup path already
        // won or the file is gone. Release is best-effort; acquisition is the
        // strict side of this protocol.
      }
    },
    release: async () => {
      const existing = parseLock(await readFile(lockPath, 'utf8').catch(() => ''))
      // WHY compare the token before removing the file:
      //
      // Stale-lock cleanup can race with a new owner. If this process is
      // shutting down after another Agent Code instance already acquired a
      // replacement lock, blindly unlinking would reopen the exact
      // multi-main-process window this file is supposed to close. The token
      // makes release ownership explicit; failure to read just means the file
      // is already gone and there is nothing to do.
      if (existing?.token === token) {
        await rm(lockPath, { force: true })
      }
    },
  }
}

export async function acquireStateProcessLock(
  options: AcquireOptions = {},
): Promise<StateProcessLock> {
  const stateDir = options.stateDir ?? STATE_DIR
  const pid = options.pid ?? process.pid
  const argv0 = options.argv0 ?? process.argv[0] ?? 'unknown'
  const now = options.now ?? (() => new Date())
  const isLockOwnerActive = options.isLockOwnerActive ?? ((owner: StateProcessLockOwner) => classifyLockOwner(owner))
  const lockPath = join(stateDir, LOCK_FILE_NAME)
  const token = randomUUID()

  await mkdir(stateDir, { recursive: true })

  for (let attempt = 0; attempt <= MAX_STALE_RETRIES; attempt += 1) {
    const payload: StateProcessLockOwner = {
      token,
      pid,
      startedAt: now().toISOString(),
      argv0,
    }
    const staging = `${lockPath}.staging-${token}`
    try {
      // Publish the lock with its CONTENT ALREADY IN IT (#1094).
      //
      // `open(..., 'wx')` creates the file and writes it afterwards, so for a
      // moment the lock exists and is EMPTY. This file already knew that — the
      // malformed-recent branch below exists because "a sibling process can
      // observe that tiny window as an empty or partial file" — and the
      // sibling's next move was to treat that empty file as a corpse and break
      // it, which is the same double-acquire from the other direction.
      //
      // Writing to a staging file and `link`ing it into place keeps the atomic
      // create (link fails EEXIST exactly like wx) while removing the window
      // entirely: the first byte anyone can see is the finished JSON.
      await writeFile(staging, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      try {
        await link(staging, lockPath)
      } catch (linkErr) {
        const code = (linkErr as NodeJS.ErrnoException).code
        // Filesystems without hard links: FAT-family volumes, and some network
        // and roaming mounts. Reachable in production wherever the state
        // directory is not on APFS/ext4 — a home on an external exFAT drive,
        // for instance.
        //
        // `ENOTSUP` is the one macOS actually returns, and review proved it on
        // a real FAT32 volume: on Darwin `ENOTSUP` (45) and `EOPNOTSUPP` (102)
        // are DIFFERENT errno values, so the first version of this list caught
        // the one that never happens and let the real one through — out of the
        // catch, past `index.ts`'s EACCES/EROFS/EPERM/ENOSPC/EDQUOT guard, and
        // into a fatal startup crash with no dialog. Linux vfat returns
        // `EPERM`, which is why that one was right by luck.
        if ((LINK_UNSUPPORTED_CODES as readonly string[]).includes(code ?? '')) {
          const handle = await open(lockPath, 'wx', 0o600)
          try {
            await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8')
          } finally {
            await handle.close()
          }
        } else {
          throw linkErr
        }
      }
      return heldLock(lockPath, token)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err

      const existing = await readExistingLock(lockPath, now)
      const existingRaw = existing.raw
      if (existing.owner) {
        const activity = normalizeLockOwnerActivity(isLockOwnerActive(existing.owner))
        if (activity === 'active') {
          return {
            acquired: false,
            path: lockPath,
            owner: existing.owner,
            reason: 'active-owner',
          }
        }
        if (
          activity === 'inconclusive' &&
          (
            existing.ownerAgeMs === null ||
            existing.ownerAgeMs < INCONCLUSIVE_OWNER_STALE_MS
          )
        ) {
          // WHY inconclusive valid locks get a short grace window:
          //
          // Two things land here, and both mean "that pid is alive but I
          // cannot prove it is ours": `ps` failed for platform or permission
          // reasons, and — since #993 — `ps` succeeded but its command line
          // did not match the recorded argv0. Deleting either immediately
          // would reopen the multi-main-process corruption window. But
          // treating an old inconclusive PID as active forever is just as bad
          // after a crash or reboot: PID reuse can make Agent Code refuse to
          // launch until the user manually deletes a JSON file in STATE_DIR.
          // Valid locks have a real `startedAt`, so we use the same
          // bounded-race policy as malformed locks: fail closed briefly, then
          // let acquisition clean up the stale file and retry.
          return {
            acquired: false,
            path: lockPath,
            owner: existing.owner,
            reason: 'active-owner',
          }
        }
      }

      if (!existing.owner && existing.invalidAgeMs === null && !existing.unreadable) {
        // The lock VANISHED between our failed create and this read — the
        // previous owner released, or another launch replaced it mid-read.
        // Nobody holds it and nothing here has an opinion about it; go round
        // and let the atomic create settle who gets it. Refusing here would
        // turn a perfectly ordinary release into a launch failure.
        continue
      }
      if (
        !existing.owner &&
        (existing.unreadable || existing.invalidAgeMs === null || existing.invalidAgeMs < INVALID_LOCK_STALE_MS)
      ) {
        // WHY invalid recent locks block instead of being deleted:
        //
        // A create-then-write lock is observable empty for a moment (the
        // `link` publish above removes that for locks this code writes, but
        // not for one written by an older build, and not on a filesystem that
        // fell back). Treating a fresh malformed lock as stale would let two
        // mains start during exactly the startup race the lock is meant to
        // prevent.
        //
        // WHY an unreadable lock blocks (#1094): breaking a lock we cannot
        // read is the one thing this function must never do — we cannot tell
        // whether it names a live owner.
        //
        // WHY it is NOT the same as "the file is gone", which the branch above
        // now handles separately: an unreadable file's age can never be
        // established (`readExistingLock` cannot date what it cannot read), so
        // a refusal that waits for it to age out waits forever. The first
        // version of this guard collapsed both into "unknown age blocks", and
        // review showed the consequence: a lock file with no read permission —
        // the migration/restore case `index.ts` names — turned into a
        // PERMANENT "Agent Code is already running" dialog with the path only
        // in a console warning. That is worse than the behaviour it replaced,
        // and it is why this refusal now carries its own reason so the caller
        // can say what to delete.
        return {
          acquired: false,
          path: lockPath,
          owner: null,
          reason: 'unreadable-lock',
        }
      }

      // Take over the stale lock by REPLACING it, atomically, and then asking
      // the file who actually ended up holding it (#1094).
      //
      // WHY not `rm(lockPath)` — which is what stood here originally, and what
      // two launches could both do to one corpse:
      //
      //   P1 rm (the corpse goes) → P1 creates its lock →
      //   P2 rm (deletes P1'S LIVE LOCK, because the delete never looked at
      //   what it was deleting) → P2 creates → both hold it.
      //
      // Measured at 19 in 40 concurrent four-launch rounds before any of this.
      //
      // WHY not the rename-the-corpse-away version either, which is what this
      // branch tried next: moving the corpse out of the way leaves the path
      // EMPTY for the two syscalls it takes to check what was moved, and
      // review caught a third launch publishing into that hole with a
      // cross-process syscall trace — after which the restore's `link` failed
      // EEXIST and the cleanup deleted the victim's only copy. 6 rounds in 80
      // at four launches, 13 in 30 at eight, ending in "a live writer and no
      // lock file", which is #993 exactly.
      //
      // A REPLACE has neither problem: `rename` onto an existing path is
      // atomic, there is never a moment where the lock is absent, and NOTHING
      // IS EVER DELETED — a launch that loses simply leaves the winner's file
      // alone. It also needs no hard links, so it behaves the same on the
      // filesystems where `link` is unavailable.
      //
      // What it does not give is a single winner: two launches that both
      // condemn the same corpse both succeed at replacing it, and each can
      // read back its own token if it reads before the other's rename lands.
      // The read below catches the common ordering, and `revalidate()` on the
      // returned handle is what makes the rest detectable rather than silent —
      // see the note there. Eliminating it needs a second lock to serialise
      // breaking, which has its own staleness problem; that is #1098.
      // Re-read immediately before replacing, and require the SAME BYTES we
      // classified.
      //
      // Classification runs `ps`, synchronously, and takes milliseconds — long
      // enough for a sibling to finish acquiring. Without this check the
      // replace would overwrite that sibling's live lock, which is a different
      // way to lose one. Review measured the window this closes at ~14 ms and
      // what is left at ~0.3 ms: the file cannot be re-read and renamed in one
      // operation, so a check this close to the rename is the best a
      // filesystem offers without a second lock (#1098).
      const stillTheCorpse = await readFile(lockPath, 'utf8').catch(() => null)
      if (stillTheCorpse !== existingRaw) continue
      await rename(staging, lockPath)
      const settled = parseLock(await readFile(lockPath, 'utf8').catch(() => ''))
      if (settled?.token === token) return heldLock(lockPath, token)
      // Another launch replaced the same corpse after us. Go round: the next
      // attempt meets THEIR lock, classifies its live owner as active, and
      // refuses — the right answer, reached without either of us deleting the
      // other's file.
    } finally {
      // The staging file is this attempt's own (it carries the token), so
      // removing it can never touch another launch's work. Unlinking it after
      // a successful `link` leaves the lock itself in place: the two names
      // point at the same inode until this one goes.
      await rm(staging, { force: true }).catch(() => undefined)
    }
  }

  return {
    acquired: false,
    path: lockPath,
    owner: null,
    reason: 'unreadable-lock',
  }
}
