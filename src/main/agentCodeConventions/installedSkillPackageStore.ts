import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { readBoundedFile } from '@main/editorFileIO.js'
import type { AgentCodeInstalledSkillFileRecord } from '@shared/types/agentCodeConventions.js'
import {
  AGENT_CODE_INSTALLED_SKILL_MAX_FILES,
  AGENT_CODE_INSTALLED_SKILL_MAX_FILE_BYTES,
  AGENT_CODE_INSTALLED_SKILL_MAX_TOTAL_BYTES,
  agentCodeInstalledSkillPathCollisionKey,
  compareAgentCodeInstalledSkillPaths,
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
    await this.assertRootIsSafe()
    const directory = this.snapshotDirectory(digest)
    await this.assertDirectChild(directory)
    await assertSnapshotDirectory(directory)
    await verifyDirectory(directory, files)
  }

  async readFile(
    digest: string,
    file: AgentCodeInstalledSkillFileRecord,
  ): Promise<Buffer> {
    assertDigest(digest)
    if (!isSafeAgentCodeInstalledSkillPath(file.path)) throw new Error('Unsafe installed skill package path')
    await this.assertRootIsSafe()
    const directory = this.snapshotDirectory(digest)
    await this.assertDirectChild(directory)
    await assertSnapshotDirectory(directory)
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
    // WHY an unreferenced snapshot is retained instead of recursively removed:
    // Node does not expose a portable openat-style recursive delete anchored to
    // the directory inode validated above. Between lstat and rm, an external
    // change could replace the private root with a link and redirect recursive
    // deletion into unmanaged data. Content-addressed snapshots are inert; a
    // little retained storage is the safe failure mode until deletion can be
    // expressed relative to a securely opened root handle.
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
  const portablePaths = new Set<string>()
  for (const file of files) {
    const portablePath = agentCodeInstalledSkillPathCollisionKey(file.path)
    if (!isSafeAgentCodeInstalledSkillPath(file.path)
      || (previous !== '' && compareAgentCodeInstalledSkillPaths(previous, file.path) >= 0)
      || paths.has(file.path)
      || portablePaths.has(portablePath)) {
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
    portablePaths.add(portablePath)
  }
  if (!paths.has('SKILL.md') || total > AGENT_CODE_INSTALLED_SKILL_MAX_TOTAL_BYTES) {
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
