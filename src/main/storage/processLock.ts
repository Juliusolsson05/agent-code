import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { open, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { STATE_DIR } from '@main/storage/paths.js'

const LOCK_FILE_NAME = 'agent-code.process-lock.json'
const INVALID_LOCK_STALE_MS = 5 * 60 * 1000
const INCONCLUSIVE_OWNER_STALE_MS = 5 * 60 * 1000
const MAX_STALE_RETRIES = 2
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
}> {
  const [raw, fileStat] = await Promise.all([
    readFile(lockPath, 'utf8').catch(() => null),
    stat(lockPath).catch(() => null),
  ])
  if (raw === null) return { owner: null, ownerAgeMs: null, invalidAgeMs: null }
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
    }
  }
  if (!fileStat) return { owner: null, ownerAgeMs: null, invalidAgeMs: null }
  return { owner: null, ownerAgeMs: null, invalidAgeMs: ageFrom(fileStat.mtimeMs, now) }
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
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      } finally {
        await handle.close()
      }
      const releaseSync = () => {
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
      }
      return {
        acquired: true,
        path: lockPath,
        token,
        releaseSync,
        release: async () => {
          const existing = parseLock(await readFile(lockPath, 'utf8').catch(() => ''))
          // WHY compare the token before removing the file:
          //
          // Stale-lock cleanup can race with a new owner. If this process is
          // shutting down after another Agent Code instance already acquired a
          // replacement lock, blindly unlinking would reopen the exact
          // multi-main-process window this file is supposed to close. The token
          // makes release ownership explicit; failure to read just means the
          // file is already gone and there is nothing to do.
          if (existing?.token === token) {
            await rm(lockPath, { force: true })
          }
        },
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err

      const existing = await readExistingLock(lockPath, now)
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

      if (
        !existing.owner &&
        existing.invalidAgeMs !== null &&
        existing.invalidAgeMs < INVALID_LOCK_STALE_MS
      ) {
        // WHY invalid recent locks block instead of being deleted:
        //
        // `open(..., 'wx')` creates the file before its JSON body is written.
        // A sibling process can observe that tiny window as an empty or partial
        // file. Treating a fresh malformed lock as stale would let two mains
        // start during exactly the startup race the lock is meant to prevent.
        return {
          acquired: false,
          path: lockPath,
          owner: null,
          reason: 'unreadable-lock',
        }
      }

      await rm(lockPath, { force: true }).catch(() => undefined)
    }
  }

  return {
    acquired: false,
    path: lockPath,
    owner: null,
    reason: 'unreadable-lock',
  }
}
