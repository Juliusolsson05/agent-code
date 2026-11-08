import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

// WHY these primitives are shared by the Codex and Claude integrations instead
// of each integration owning a copy: the guarantees below (never follow a
// symlink, never claim a user-written skill, detect a concurrent writer before
// the final rename) are the whole safety story of writing into another
// product's home directory. Two copies would drift, and the copy that drifted
// is the one that would eventually clobber somebody's config.

const skillMarker = '\n<!-- agent-code-external-operator:v1 '
const sha = (value: string) => createHash('sha256').update(value).digest('hex')

/** The installed bytes: the source plus a trailing digest of exactly that source. */
export function ownedSkillBytes(skillSource: string): string {
  return skillSource + `${skillMarker}${sha(skillSource)} -->\n`
}

/**
 * Throws unless `installed` is a skill this app wrote byte-for-byte. Marked
 * content carries its own exact-byte ownership proof, so interrupted installs
 * and app upgrades (a different source text) reconcile without claiming a
 * user-created file or a user's edit of ours.
 */
export function assertOwnedSkill(installed: string | null, skillPath: string): void {
  if (installed === null) return
  const marker = installed.lastIndexOf(skillMarker)
  if (marker < 0 || installed.slice(marker) !== `${skillMarker}${sha(installed.slice(0, marker))} -->\n`) {
    throw new Error(`Operator skill is not app-owned or was edited: ${skillPath}`)
  }
}

export async function readRegular(path: string): Promise<string | null> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected an ordinary file; refusing to replace: ${path}`)
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function replaceObserved(path: string, observed: string | null, next: string | null): Promise<void> {
  if (observed === next) return
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    if (next !== null) await writeFile(temporary, next, { mode: 0o600, flag: 'wx' })
    // Detect edits made during staging, including the client's own config
    // writer. Atomic rename prevents torn reads. There is no cross-product
    // filesystem CAS protocol; another writer in the final check/rename
    // interval can still race, so keep that interval free of application
    // awaits or extra work. (Claude's file additionally gets its own lock; see
    // externalClaudeIntegration.ts.)
    if (await readRegular(path) !== observed) throw new Error(`File changed during setup; retry: ${path}`)
    if (next === null) await unlink(path)
    else await rename(temporary, path)
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}
