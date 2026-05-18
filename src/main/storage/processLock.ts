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

function defaultIsPidRunning(pid: number): boolean {
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
  if (!defaultIsPidRunning(owner.pid)) return 'inactive'
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
  return ownerExecutable.length === 0 || commandLine.includes(owner.argv0) || commandLine.includes(ownerExecutable)
    ? 'active'
    : 'inactive'
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
          // `ps` can fail for platform/permission reasons even while the
          // recorded PID is alive. Deleting that lock immediately would reopen
          // the multi-main-process corruption window. But treating an old
          // inconclusive PID as active forever is just as bad after a crash or
          // reboot: PID reuse can make Agent Code refuse to launch until the
          // user manually deletes a JSON file in STATE_DIR. Valid locks have a
          // real `startedAt`, so we use the same bounded-race policy as
          // malformed locks: fail closed briefly, then let acquisition clean up
          // the stale file and retry.
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
