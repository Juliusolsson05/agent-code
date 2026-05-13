import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { LEGACY_STATE_DIR, STATE_DIR } from '@main/storage/paths.js'

const LEGACY_USER_DATA_DIR_NAMES = ['Agent Studio Code', 'cc-shell']
const USER_DATA_SUBDIRS_TO_MIGRATE = [
  'ghost-logs',
  'dictation-debug',
  'paste-debug',
  'native-helpers',
]

// Chromium-owned renderer storage needs whole-directory replacement, not a
// recursive "copy missing files" merge.
//
// WHY: Local Storage / Session Storage are LevelDB-ish stores. They contain
// manifest/log files whose names intentionally overlap between two separate
// app identities. Merging file-by-file can pair a legacy MANIFEST with a fresh
// CURRENT pointer and corrupt both the migrated settings and the new store.
// For this temporary conversion branch, we replace the target only when it is
// still a fresh Chromium bootstrap. If the target already has real data, we
// leave the legacy directory in place and log loudly rather than deleting the
// only copy of the old renderer state.
const USER_DATA_SUBDIRS_TO_REPLACE_IF_FRESH = [
  'Local Storage',
  'Session Storage',
  'WebStorage',
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

async function isFreshChromiumStore(dir: string): Promise<boolean> {
  if (!(await exists(dir))) return true

  const leveldbDir = join(dir, 'leveldb')
  if (await exists(leveldbDir)) {
    const entries = await readdir(leveldbDir).catch(() => [] as string[])
    for (const name of entries) {
      if (name.endsWith('.ldb')) return false
      if (/^[0-9]+\.log$/i.test(name)) return false
    }
    return true
  }

  const entries = await readdir(dir).catch(() => [] as string[])
  return entries.length === 0
}

async function replaceIfTargetFresh(fromDir: string, toDir: string): Promise<boolean> {
  if (!(await exists(fromDir))) return false
  if (!(await isFreshChromiumStore(toDir))) return false
  if (await exists(toDir)) {
    await rm(toDir, { recursive: true, force: true })
  }
  await cp(fromDir, toDir, { recursive: true, force: false, errorOnExist: false })
  return true
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

  // Temporary conversion branch: once both dirs exist, merge anything that only
  // exists in the old cc-shell tree and then remove the legacy tree. PR #82
  // intentionally left it behind for rollback. That made sense during the
  // rename window; it is now exactly the noise this branch is meant to flush
  // out before the final "delete legacy support" commit.
  await copyMissingEntries(LEGACY_STATE_DIR, STATE_DIR)
  await rm(LEGACY_STATE_DIR, { recursive: true, force: true })
}

export async function migrateLegacyUserDataDirs(currentUserDataDir: string): Promise<void> {
  const supportDir = dirname(currentUserDataDir)
  await mkdir(currentUserDataDir, { recursive: true })

  for (const legacyName of LEGACY_USER_DATA_DIR_NAMES) {
    const legacyDir = join(supportDir, legacyName)
    if (legacyDir === currentUserDataDir || !(await exists(legacyDir))) continue
    let fullyConverted = true

    for (const subdir of USER_DATA_SUBDIRS_TO_MIGRATE) {
      const from = join(legacyDir, subdir)
      if (!(await exists(from))) continue

      // These are Agent Code-owned append-only/runtime dirs, so "copy missing
      // entries into the current identity" is a real conversion. Unlike PR #82,
      // this temporary branch does not preserve the source dir for rollback
      // after the known durable pieces have moved.
      await copyMissingEntries(from, join(currentUserDataDir, subdir))
    }

    for (const subdir of USER_DATA_SUBDIRS_TO_REPLACE_IF_FRESH) {
      const from = join(legacyDir, subdir)
      if (!(await exists(from))) continue
      const replaced = await replaceIfTargetFresh(from, join(currentUserDataDir, subdir))
      if (!replaced) {
        fullyConverted = false
        console.warn(
          `[state] could not safely convert ${legacyName}/${subdir}; ` +
          'target store already has data, leaving legacy userData dir in place',
        )
      }
    }

    if (fullyConverted) {
      await rm(legacyDir, { recursive: true, force: true })
    }
  }
}
