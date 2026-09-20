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

function defaultIsLockOwnerActive(owner: StateProcessLockOwner): LockOwnerActivity {
  if (!isPidRunning(owner.pid)) return 'inactive'
  const commandLine = commandLineForPid(owner.pid)
  if (!commandLine) return 'inconclusive'
  const ownerExecutable = basename(owner.argv0)
  // WHY PID liveness is not enough:
  //
  // Lock files intentionally survive crashes so the next launch can decide
  // whether the recorded owner is still alive. PIDs are recycled, though; a
  // random unrelated process can inherit the old number after reboot and make
  // `kill(pid, 0)` succeed forever. The command-line check is not a security
  // boundary, but it is a practical stale-lock discriminator: a live Agent
  // Code/Electron owner still advertises the executable that wrote the lock,
  // while a recycled PID almost certainly does not.
  if (
    ownerExecutable.length === 0 ||
    commandLine.includes(owner.argv0) ||
    commandLine.includes(ownerExecutable)
  ) {
    return 'active'
  }
  // ── A LIVE PID WE CANNOT CONFIRM IS 'inconclusive', NEVER 'inactive' (#993) ──
  //
  // This used to answer 'inactive' here, which sends acquisition down the
  // stale-lock path: delete the file and take over. But the only thing that
  // failed is a STRING MATCH against a command line — and there are ordinary
  // reasons for that to fail while the owner is very much alive and writing:
  // the bundle was replaced in place by an update, the app was renamed or
  // moved, a dev binary lives at a path that has since changed, or `ps`
  // rendered the argv differently than `process.argv[0]` spelled it.
  //
  // Acting on that guess is what #993 looks like from the inside. Two mains
  // ran against ~/.config/agent-code at once, and then the lock file was gone
  // ENTIRELY — because once the incumbent's lock has been overwritten, its own
  // release no longer matches the token, so whichever process exits first
  // deletes the file and leaves the other running unprotected and invisible.
  //
  // The asymmetry decides it. Refusing to steal costs a bounded wait: the
  // grace window below expires and the lock is cleaned up anyway, so PID reuse
  // after a reboot still cannot lock anyone out. Stealing costs two main
  // processes writing one state directory, which is the corruption this whole
  // file exists to prevent. So 'inactive' is now reserved for the one case we
  // actually KNOW: the pid is gone.
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
      ownerAgeMs: ageBaseMs === undefined ? null : now().getTime() - ageBaseMs,
      invalidAgeMs: null,
    }
  }
  if (!fileStat) return { owner: null, ownerAgeMs: null, invalidAgeMs: null }
  return { owner: null, ownerAgeMs: null, invalidAgeMs: now().getTime() - fileStat.mtimeMs }
}

export async function acquireStateProcessLock(
  options: AcquireOptions = {},
): Promise<StateProcessLock> {
  const stateDir = options.stateDir ?? STATE_DIR
  const pid = options.pid ?? process.pid
  const argv0 = options.argv0 ?? process.argv[0] ?? 'unknown'
  const now = options.now ?? (() => new Date())
  const isLockOwnerActive = options.isLockOwnerActive ?? defaultIsLockOwnerActive
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
