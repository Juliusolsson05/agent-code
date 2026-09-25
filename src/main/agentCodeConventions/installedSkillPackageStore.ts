import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { readBoundedFile } from '@main/editorFileIO.js'
import type { AgentCodeInstalledSkillFileRecord } from '@shared/types/agentCodeConventions.js'
import {
  AGENT_CODE_INSTALLED_SKILL_MAX_FILES,
  AGENT_CODE_INSTALLED_SKILL_MAX_FILE_BYTES,
  AGENT_CODE_INSTALLED_SKILL_MAX_TOTAL_BYTES,
  compareAgentCodeInstalledSkillPaths,
  findAgentCodeInstalledSkillPathCollision,
  isSafeAgentCodeInstalledSkillPath,
} from '@shared/types/agentCodeInstalledSkills.js'
import type { StagedInstalledSkillCandidate } from './githubSkillSource.js'

/**
 * Stores immutable GitHub package snapshots under an app-owned private root.
 *
 * WHY this is separate from provider materialization: source bytes must become
 * durable before desired state points at them, while provider copies are
 * recoverable generated artifacts. Conflating the two would make a partial
 * provider write capable of destroying the only reviewed package snapshot.
 */
export class InstalledSkillPackageStore {
  constructor(private readonly root: string) {}

  async store(candidate: StagedInstalledSkillCandidate): Promise<void> {
    assertDigest(candidate.snapshotDigest)
    validateManifest(candidate.candidate.files)
    if (manifestDigest(candidate.candidate.files) !== candidate.snapshotDigest) {
      throw new Error('Installed skill snapshot digest does not match its manifest')
    }
    validateContents(candidate.candidate.files, candidate.contents)
    await this.ensureRoot()
    const destination = this.snapshotDirectory(candidate.snapshotDigest)
    const existing = await lstat(destination).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (existing) {
      await this.verify(candidate.snapshotDigest, candidate.candidate.files)
      return
    }

    // WHY there is no whole-root budget any more (#1161): it existed only
    // because unreferenced snapshots were never deleted, and in practice it
    // became a hidden skills-count cap ("Quit Agent Code and remove old
    // snapshots"). Snapshots nothing references are now removed by
    // `removeIfUnreferenced`/`sweepUnreferenced`, and each admitted package is
    // still bounded by the per-package manifest limits validated above.

    // WHY failed staging directories are allowed to remain: recursively
    // cleaning a path after releasing the validated root inode has the same
    // ancestor-swap problem as snapshot GC. A successful rename makes this
    // path disappear. The rare failed/concurrent case leaves only bounded,
    // inert package bytes under the private root, which is safer than risking
    // deletion outside it.
    const staging = await mkdtemp(join(this.root, '.staging-'))
    for (const file of candidate.candidate.files) {
      const target = join(staging, ...file.path.split('/'))
      await this.ensureContainedDirectory(dirname(target), staging)
      await writeFile(target, candidate.contents.get(file.path)!, {
        flag: 'wx',
        mode: file.executable ? 0o700 : 0o600,
      })
      // umask may narrow permissions (which is fine) but never let a
      // permissive inherited default make imported executable data writable
      // by other users.
      await chmod(target, file.executable ? 0o700 : 0o600)
    }
    await verifyDirectory(staging, candidate.candidate.files)
    try {
      await rename(staging, destination)
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      await this.verify(candidate.snapshotDigest, candidate.candidate.files)
    }
  }

  async verify(digest: string, files: AgentCodeInstalledSkillFileRecord[]): Promise<void> {
    assertDigest(digest)
    validateManifest(files)
    if (manifestDigest(files) !== digest) {
      throw new Error('Installed skill snapshot digest does not match its manifest')
    }
    const directory = await this.recordedSnapshotDirectory(digest)
    await verifyDirectory(directory, files)
  }

  async readFile(
    digest: string,
    file: AgentCodeInstalledSkillFileRecord,
  ): Promise<Buffer> {
    assertDigest(digest)
    if (!isSafeAgentCodeInstalledSkillPath(file.path)) throw new Error('Unsafe installed skill package path')
    const directory = await this.recordedSnapshotDirectory(digest)
    const target = join(directory, ...file.path.split('/'))
    await assertNoLinksBetween(directory, target)
    const read = await readBoundedFile(target, AGENT_CODE_INSTALLED_SKILL_MAX_FILE_BYTES)
    if (read.stat.size !== file.bytes
      || ((read.stat.mode & 0o111) !== 0) !== file.executable) {
      throw new Error(`Installed skill snapshot file is not trustworthy: ${file.path}`)
    }
    if (sha256(read.bytes) !== file.sha256) {
      throw new Error(`Installed skill snapshot changed outside Agent Code: ${file.path}`)
    }
    return read.bytes
  }

  async resolveRevealDirectory(digest: string): Promise<string | null> {
    assertDigest(digest)
    try {
      await this.assertRootIsSafe()
      const directory = this.snapshotDirectory(digest)
      await this.assertDirectChild(directory)
      const stat = await lstat(directory)
      return stat.isDirectory() && !stat.isSymbolicLink() ? directory : null
    } catch {
      return null
    }
  }

  async removeIfUnreferenced(digest: string, referencedDigests: Set<string>): Promise<void> {
    assertDigest(digest)
    if (referencedDigests.has(digest)) return
    await this.assertRootIsSafe()
    const directory = this.snapshotDirectory(digest)
    await this.assertDirectChild(directory)
    const stat = await lstat(directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (!stat) return
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Installed skill snapshot path changed outside Agent Code')
    }
    // WHY quarantine first: the rename happens inside the validated private
    // root and gives the directory an unguessable name, so nothing that
    // races us by the well-known `<digest>` name can be swept up below. The
    // digest stays in the name so a crash mid-cleanup leaves evidence the
    // next sweep can finish with the same proof.
    const quarantine = join(this.root, `.trash-${digest}-${randomUUID()}`)
    await rename(directory, quarantine)
    await this.removeProvenSnapshot(quarantine, digest)
  }

  /**
   * Removes every snapshot (and interrupted `.trash-<digest>-*` quarantine)
   * that `referencedDigests` does not name. Best effort per entry: a snapshot
   * that fails its proof is left in place, inert, and the sweep continues.
   *
   * WHY `.staging-*` directories are skipped: they have no digest in their
   * name, so there is nothing to prove their contents against. They only
   * exist after a failed store and are bounded by the per-package limits.
   */
  async sweepUnreferenced(referencedDigests: Set<string>): Promise<{ removed: number; failed: number }> {
    let removed = 0
    let failed = 0
    try {
      await this.assertRootIsSafe()
    } catch {
      return { removed, failed }
    }
    const entries = await readdir(this.root, { withFileTypes: true })
    for (const entry of entries) {
      const trash = /^\.trash-([a-f0-9]{64})-[0-9a-f-]{36}$/.exec(entry.name)
      const digest = /^[a-f0-9]{64}$/.test(entry.name) ? entry.name : trash?.[1]
      if (!digest || referencedDigests.has(digest)) continue
      try {
        if (trash) {
          const path = join(this.root, entry.name)
          await this.assertDirectChild(path)
          await this.removeProvenSnapshot(path, digest)
        } else {
          await this.removeIfUnreferenced(digest, referencedDigests)
        }
        removed += 1
      } catch {
        failed += 1
      }
    }
    return { removed, failed }
  }

  /**
   * Deletes a quarantined snapshot using only non-recursive primitives.
   *
   * WHY this is safe enough to replace the old "retain forever" rule
   * (docs/design/agent-code-conventions.md): content addressing makes the
   * digest a proof of the directory's exact bytes. The manifest is rebuilt
   * FROM DISK (links, special files and unsafe names are rejected by the
   * walk) and must hash to that digest before anything is unlinked, so a
   * directory holding anything we did not store is never touched. Each file
   * is re-hashed immediately before its unlink, and directories are removed
   * with `rmdir`, which refuses a non-empty directory — an unexpected entry
   * stops the cleanup instead of widening it. The residual ancestor-swap race
   * can at worst unlink a file byte-identical to one of our own snapshot
   * files at the same relative path, the same bound provider-root removal
   * already accepts.
   */
  private async removeProvenSnapshot(directory: string, digest: string): Promise<void> {
    await assertSnapshotDirectory(directory)
    const paths = await walkRegularFiles(directory)
    const files: AgentCodeInstalledSkillFileRecord[] = []
    for (const relativePath of paths) {
      const target = join(directory, ...relativePath.split('/'))
      await assertNoLinksBetween(directory, target)
      const read = await readBoundedFile(target, AGENT_CODE_INSTALLED_SKILL_MAX_FILE_BYTES)
      files.push({
        path: relativePath,
        bytes: read.bytes.byteLength,
        sha256: sha256(read.bytes),
        executable: (read.stat.mode & 0o111) !== 0,
      })
    }
    files.sort((left, right) => compareAgentCodeInstalledSkillPaths(left.path, right.path))
    if (files.length === 0 || manifestDigest(files) !== digest) {
      throw new Error('Installed skill snapshot no longer matches its digest; it was left in place.')
    }
    for (const file of files) {
      const target = join(directory, ...file.path.split('/'))
      await assertNoLinksBetween(directory, target)
      const read = await readBoundedFile(target, AGENT_CODE_INSTALLED_SKILL_MAX_FILE_BYTES)
      if (sha256(read.bytes) !== file.sha256) {
        throw new Error('Installed skill snapshot changed during cleanup; it was left in place.')
      }
      await unlink(target)
    }
    const directories = new Set<string>()
    for (const file of files) {
      const segments = file.path.split('/')
      for (let length = segments.length - 1; length >= 1; length -= 1) {
        directories.add(segments.slice(0, length).join('/'))
      }
    }
    // Deepest first, so every rmdir sees an already-emptied child.
    const ordered = [...directories].sort((left, right) =>
      right.split('/').length - left.split('/').length || compareAgentCodeInstalledSkillPaths(left, right))
    for (const relativePath of ordered) await rmdir(join(directory, ...relativePath.split('/')))
    await rmdir(directory)
  }

  private snapshotDirectory(digest: string): string {
    return join(this.root, digest)
  }

  private async ensureRoot(): Promise<void> {
    if (!isAbsolute(this.root)) throw new Error('Installed skill snapshot root must be absolute')
    // The state directory is the trust anchor already used by the rest of the
    // app. Checking from the filesystem root would reject legitimate platform
    // layouts such as macOS /var -> /private/var, while lstat'ing the app-owned
    // parent and direct child still prevents the snapshot root itself from
    // being replaced by a link.
    const parent = dirname(this.root)
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const parentStat = await lstat(parent)
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      throw new Error('Installed skill snapshot parent is not a regular directory')
    }
    try {
      await mkdir(this.root, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const rootStat = await lstat(this.root)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error('Installed skill snapshot root is not a regular directory')
    }
    await chmod(this.root, 0o700)
  }

  /**
   * Resolves the snapshot a journal record points at, for reading.
   *
   * WHY ENOENT is translated here (#1206): `verify` failures end up on every
   * provider row of the skill in Settings → Skills, and the raw
   * `ENOENT … lstat '<64-hex path>'` made a healthy provider copy look broken
   * while naming a path the user had never heard of. Whether the snapshot
   * directory, the whole store or its parent is gone, the meaning is the
   * same: the provider copy may be fine, but Agent Code can no longer prove
   * it matches what was reviewed. WHY the message makes no claim about
   * recovery: applying a reviewed update re-stores the snapshot and heals the
   * skill (review of PR #1211 verified that), so an earlier "cannot be
   * updated" wording steered users away from the one working fix. WHY only for these reads and not inside
   * `assertSnapshotDirectory`: that one also guards nested directories and
   * quarantines mid-cleanup, where "missing from the store" would be false.
   * Other errnos (EACCES, ELOOP…) stay raw because they are environment
   * faults worth seeing verbatim.
   */
  private async recordedSnapshotDirectory(digest: string): Promise<string> {
    const directory = this.snapshotDirectory(digest)
    try {
      await this.assertRootIsSafe()
      await this.assertDirectChild(directory)
      await assertSnapshotDirectory(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      throw new Error(
        `Agent Code's reviewed copy of this skill is missing from ${basename(this.root)}, `
        + 'so this copy cannot be verified',
      )
    }
    return directory
  }

  private async assertRootIsSafe(): Promise<void> {
    if (!isAbsolute(this.root)) throw new Error('Installed skill snapshot root must be absolute')
    const parent = await lstat(dirname(this.root))
    if (parent.isSymbolicLink() || !parent.isDirectory()) {
      throw new Error('Installed skill snapshot parent is not a regular directory')
    }
    const stat = await lstat(this.root)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Installed skill snapshot root is not a regular directory')
    }
  }

  private async assertDirectChild(directory: string): Promise<void> {
    const fromRoot = relative(resolve(this.root), resolve(directory))
    if (!fromRoot || fromRoot.startsWith(`..${sep}`) || fromRoot === '..'
      || isAbsolute(fromRoot) || fromRoot.includes(sep)) {
      throw new Error('Installed skill snapshot path escaped its private root')
    }
  }

  private async ensureContainedDirectory(directory: string, containmentRoot: string): Promise<void> {
    const fromRoot = relative(resolve(containmentRoot), resolve(directory))
    if (fromRoot.startsWith(`..${sep}`) || fromRoot === '..' || isAbsolute(fromRoot)) {
      throw new Error('Installed skill package path escaped its staging root')
    }
    let cursor = resolve(containmentRoot)
    for (const segment of fromRoot.split(sep).filter(Boolean)) {
      cursor = join(cursor, segment)
      try {
        await mkdir(cursor, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      const stat = await lstat(cursor)
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error('Installed skill staging path is not a regular directory')
      }
    }
  }
}

function validateManifest(files: AgentCodeInstalledSkillFileRecord[]): void {
  if (files.length === 0 || files.length > AGENT_CODE_INSTALLED_SKILL_MAX_FILES) {
    throw new Error('Installed skill manifest has an invalid file count')
  }
  let total = 0
  let previous = ''
  const paths = new Set<string>()
  for (const file of files) {
    if (!isSafeAgentCodeInstalledSkillPath(file.path)
      || (previous !== '' && compareAgentCodeInstalledSkillPaths(previous, file.path) >= 0)
      || paths.has(file.path)) {
      throw new Error('Installed skill manifest paths are unsafe or unsorted')
    }
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0
      || file.bytes > AGENT_CODE_INSTALLED_SKILL_MAX_FILE_BYTES
      || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error(`Installed skill manifest entry is invalid: ${file.path}`)
    }
    total += file.bytes
    previous = file.path
    paths.add(file.path)
  }
  if (!paths.has('SKILL.md')
    || findAgentCodeInstalledSkillPathCollision([...paths]) !== null
    || total > AGENT_CODE_INSTALLED_SKILL_MAX_TOTAL_BYTES) {
    throw new Error('Installed skill manifest is incomplete or oversized')
  }
}

function validateContents(
  files: AgentCodeInstalledSkillFileRecord[],
  contents: Map<string, Buffer>,
): void {
  if (contents.size !== files.length) throw new Error('Installed skill package content is incomplete')
  for (const file of files) {
    const content = contents.get(file.path)
    if (!content || content.byteLength !== file.bytes || sha256(content) !== file.sha256) {
      throw new Error(`Installed skill package content does not match its manifest: ${file.path}`)
    }
  }
}

async function verifyDirectory(
  directory: string,
  files: AgentCodeInstalledSkillFileRecord[],
): Promise<void> {
  await assertSnapshotDirectory(directory)
  const expected = new Map(files.map(file => [file.path, file]))
  const discovered = await walkRegularFiles(directory)
  if (discovered.length !== expected.size) {
    throw new Error('Installed skill snapshot contains unexpected or missing files')
  }
  for (const relativePath of discovered) {
    const file = expected.get(relativePath)
    if (!file) throw new Error(`Installed skill snapshot contains an unexpected file: ${relativePath}`)
    const target = join(directory, ...relativePath.split('/'))
    await assertNoLinksBetween(directory, target)
    const read = await readBoundedFile(target, AGENT_CODE_INSTALLED_SKILL_MAX_FILE_BYTES)
    if (read.stat.size !== file.bytes
      || ((read.stat.mode & 0o111) !== 0) !== file.executable) {
      throw new Error(`Installed skill snapshot file is invalid: ${relativePath}`)
    }
    if (sha256(read.bytes) !== file.sha256) {
      throw new Error(`Installed skill snapshot file changed: ${relativePath}`)
    }
  }
}

async function walkRegularFiles(root: string): Promise<string[]> {
  const result: string[] = []
  const visit = async (directory: string, prefix: string): Promise<void> => {
    await assertSnapshotDirectory(directory)
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) throw new Error('Installed skill snapshot contains a symbolic link')
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (!isSafeAgentCodeInstalledSkillPath(relativePath)) throw new Error('Installed skill snapshot contains an unsafe path')
      const absolutePath = join(directory, entry.name)
      if (entry.isDirectory()) await visit(absolutePath, relativePath)
      else if (entry.isFile()) result.push(relativePath)
      else throw new Error('Installed skill snapshot contains a non-regular filesystem object')
      if (result.length > AGENT_CODE_INSTALLED_SKILL_MAX_FILES) {
        throw new Error('Installed skill snapshot exceeds the file-count limit')
      }
    }
  }
  await visit(root, '')
  return result.sort()
}

async function assertNoLinksBetween(root: string, target: string): Promise<void> {
  const fromRoot = relative(resolve(root), resolve(target))
  if (!fromRoot || fromRoot.startsWith(`..${sep}`) || fromRoot === '..' || isAbsolute(fromRoot)) {
    throw new Error('Installed skill snapshot file escaped its root')
  }
  let cursor = resolve(root)
  await assertSnapshotDirectory(cursor)
  for (const segment of fromRoot.split(sep)) {
    cursor = join(cursor, segment)
    const stat = await lstat(cursor)
    if (stat.isSymbolicLink()) throw new Error('Installed skill snapshot contains a symbolic link')
  }
}

async function assertSnapshotDirectory(directory: string): Promise<void> {
  const stat = await lstat(directory)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Installed skill snapshot is not a regular directory')
  }
}

function assertDigest(digest: string): void {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid installed skill snapshot digest')
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function installedSkillManifestDigest(files: AgentCodeInstalledSkillFileRecord[]): string {
  return manifestDigest(files)
}

function manifestDigest(files: AgentCodeInstalledSkillFileRecord[]): string {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(file.sha256)
    hash.update('\0')
    hash.update(file.executable ? '1' : '0')
    hash.update('\0')
  }
  return hash.digest('hex')
}
