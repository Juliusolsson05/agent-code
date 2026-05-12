import { cp, mkdir, readdir, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { LEGACY_STATE_DIR, STATE_DIR } from '@main/storage/paths.js'

const LEGACY_USER_DATA_DIR_NAMES = ['Agent Studio Code', 'cc-shell']
const USER_DATA_SUBDIRS_TO_MIGRATE = [
  'ghost-logs',
  'dictation-debug',
  'paste-debug',
  'native-helpers',
]

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function copyMissingEntries(fromDir: string, toDir: string): Promise<void> {
  await mkdir(toDir, { recursive: true })
  const entries = await readdir(fromDir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const from = join(fromDir, entry.name)
    const to = join(toDir, entry.name)

    if (entry.isDirectory() && (await exists(to))) {
      await copyMissingEntries(from, to)
      continue
    }

    if (await exists(to)) continue
    await cp(from, to, { recursive: entry.isDirectory(), force: false, errorOnExist: true })
  }
}

export async function migrateLegacyStateDir(): Promise<void> {
  if (STATE_DIR === LEGACY_STATE_DIR) {
    await mkdir(STATE_DIR, { recursive: true })
    return
  }

  const hasLegacy = await exists(LEGACY_STATE_DIR)
  const hasCurrent = await exists(STATE_DIR)

  if (!hasLegacy) {
    await mkdir(STATE_DIR, { recursive: true })
    return
  }

  if (!hasCurrent) {
    // WHY rename first instead of copy: the old ~/.config/cc-shell directory can
    // contain many GiB of proxy/feed/debug artifacts. A recursive copy would
    // temporarily double disk usage, exactly the failure mode that forced us to
    // add bounded retention. Same-volume rename is atomic and keeps all old
    // workspace/debug state available at the new Agent Code path.
    await rename(LEGACY_STATE_DIR, STATE_DIR)
    return
  }

  // Both directories existing means the user has already launched a newer
  // build, or manually created the Agent Code state dir. In that case we merge
  // only entries that do not already exist, preserving the newer directory as
  // the source of truth. We intentionally leave the legacy directory behind:
  // deleting user state after a partial merge would make rollback impossible.
  await copyMissingEntries(LEGACY_STATE_DIR, STATE_DIR)
}

export async function migrateLegacyUserDataDirs(currentUserDataDir: string): Promise<void> {
  const supportDir = dirname(currentUserDataDir)
  await mkdir(currentUserDataDir, { recursive: true })

  for (const legacyName of LEGACY_USER_DATA_DIR_NAMES) {
    const legacyDir = join(supportDir, legacyName)
    if (legacyDir === currentUserDataDir || !(await exists(legacyDir))) continue

    for (const subdir of USER_DATA_SUBDIRS_TO_MIGRATE) {
      const from = join(legacyDir, subdir)
      if (!(await exists(from))) continue

      // WHY copy subdirectories instead of renaming the whole legacy userData
      // tree: Electron's userData location also contains framework-owned cache
      // and per-build files whose shape can differ between dev and packaged
      // runs. The Agent Code-owned durable pieces are known and small enough
      // to merge safely, and leaving the old directory intact keeps rollback to
      // pre-rename builds possible.
      await copyMissingEntries(from, join(currentUserDataDir, subdir))
    }
  }
}
