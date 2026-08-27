import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { atomicWriteFile } from '@main/editorFileIO.js'
import type {
  AgentCodeInstalledSkillFileRecord,
  AgentCodeInstalledSkillMaterialization,
  AgentCodeInstalledSkillPendingOperation,
} from '@shared/types/agentCodeConventions.js'
import {
  AGENT_CODE_INSTALLED_SKILL_MAX_FILES,
  AGENT_CODE_INSTALLED_SKILL_MAX_FILE_BYTES,
  isSafeAgentCodeInstalledSkillPath,
} from '@shared/types/agentCodeInstalledSkills.js'
import { journalCaptureDirectory, journalTemporaryPath, SkillPathSafety } from './skillPathSafety.js'
import type { InstalledSkillPackageStore } from './installedSkillPackageStore.js'
import type { AgentCodeConventionsTarget } from './targets.js'

export type InstalledPackagePreflight =
  | { kind: 'writable' }
  | { kind: 'conflict'; message: string; fingerprint: string }

export type InstalledPackageMutationResult =
  | { ok: true; materialization: AgentCodeInstalledSkillMaterialization | null }
  | { ok: false; kind: 'conflict' | 'error'; message: string; fingerprint?: string }

type InspectedPackageFile = AgentCodeInstalledSkillFileRecord & { version: string }

type InspectedPackage =
  | { kind: 'files'; files: Map<string, InspectedPackageFile> }
  | { kind: 'conflict'; message: string; fingerprint: string }

/**
 * Applies one already-journaled package operation to one physical provider
 * target. It owns file mutation mechanics, but never decides desired state or
 * writes the canonical document; the managed-skills service remains the sole
 * authority that can create the journal passed here.
 */
export class InstalledSkillMaterializer {
  constructor(
    private readonly pathSafety: SkillPathSafety,
    private readonly packageStore: InstalledSkillPackageStore,
  ) {}

  async preflight(
    target: AgentCodeConventionsTarget,
    existing: AgentCodeInstalledSkillMaterialization | undefined,
  ): Promise<InstalledPackagePreflight> {
    const inspected = await this.inspectPackage(target.skillDirectory)
    if (inspected.kind === 'conflict') return inspected
    if (inspected.files.size === 0) return { kind: 'writable' }
    if (!existing || resolve(existing.path) !== resolve(target.skillDirectory)) {
      return conflictForFiles(
        target.skillDirectory,
        inspected.files,
        'A personal skill package with this name already exists outside Agent Code.',
      )
    }
    const expected = new Map(existing.files.map(file => [file.path, file]))
    if (!sameInspectedManifest(inspected.files, expected)) {
      return conflictForFiles(
        target.skillDirectory,
        inspected.files,
        'The installed package changed outside Agent Code.',
      )
    }
    return { kind: 'writable' }
  }

  async apply(
    target: AgentCodeConventionsTarget,
    operation: AgentCodeInstalledSkillPendingOperation,
  ): Promise<InstalledPackageMutationResult> {
    try {
      if (resolve(operation.path) !== resolve(target.skillDirectory)
        || operation.targetId !== target.id) {
        throw new Error('Installed package journal does not match the current provider target')
      }
      const inspected = await this.inspectPackage(target.skillDirectory)
      if (inspected.kind === 'conflict') {
        return { ok: false, kind: 'conflict', message: inspected.message, fingerprint: inspected.fingerprint }
      }
      const previous = new Map(operation.previousFiles.map(file => [file.path, file]))
      const desired = new Map(operation.desiredFiles.map(file => [file.path, file]))
      const allowedPaths = new Set([...previous.keys(), ...desired.keys()])
      for (const [path, current] of inspected.files) {
        if (!allowedPaths.has(path)) {
          return conflictForMutation(
            target.skillDirectory,
            inspected.files,
            `An unexpected external file was preserved: ${path}.`,
          )
        }
        const previousFile = previous.get(path)
        const desiredFile = desired.get(path)
        if (!matchesManifestFile(current, previousFile) && !matchesManifestFile(current, desiredFile)) {
          return conflictForMutation(
            target.skillDirectory,
            inspected.files,
            `An externally changed file was preserved: ${path}.`,
          )
        }
      }

      await this.pathSafety.ensureTargetDirectory(target)
      for (const desiredFile of operation.desiredFiles) {
        const current = inspected.files.get(desiredFile.path)
        if (current && matchesManifestFile(current, desiredFile)) continue
        const previousFile = previous.get(desiredFile.path)
        if (current
          && !matchesManifestFile(current, previousFile)
          && current.sha256 !== desiredFile.sha256) {
          return conflictForMutation(
            target.skillDirectory,
            inspected.files,
            `The target changed immediately before publication: ${desiredFile.path}.`,
          )
        }
        const content = await this.packageStore.readFile(
          operation.desiredSnapshotDigest!,
          desiredFile,
        )
        const absolutePath = packageFilePath(target.skillDirectory, desiredFile.path)
        await ensureNestedDirectory(target.skillDirectory, absolutePath)
        const result = await atomicWriteFile({
          absolutePath,
          bytes: content,
          expectedVersion: current?.version ?? null,
          expectedSha256: current?.sha256,
          maxBytes: AGENT_CODE_INSTALLED_SKILL_MAX_FILE_BYTES,
          mode: desiredFile.executable ? 0o700 : 0o600,
          temporaryPath: journalTemporaryPath(absolutePath, operation.operationId),
          captureDirectory: journalCaptureDirectory(absolutePath, operation.operationId),
        })
        if (!result.ok) {
          return {
            ok: false,
            kind: 'conflict',
            message: `The target changed while Agent Code was publishing ${desiredFile.path}.`,
          }
        }
      }

      for (const previousFile of operation.previousFiles) {
        if (desired.has(previousFile.path)) continue
        const current = inspected.files.get(previousFile.path)
        if (current && !matchesManifestFile(current, previousFile)) {
          return conflictForMutation(
            target.skillDirectory,
            inspected.files,
            `External changes were preserved in ${previousFile.path}.`,
          )
        }
        const removed = await this.removeOwnedFile(
          target.skillDirectory,
          previousFile,
          operation.operationId,
        )
        if (!removed.ok) return removed
      }

      if (operation.kind === 'delete') return { ok: true, materialization: null }
      const verified = await this.inspectPackage(target.skillDirectory)
      if (verified.kind === 'conflict') {
        return { ok: false, kind: 'conflict', message: verified.message, fingerprint: verified.fingerprint }
      }
      const desiredManifest = new Map(operation.desiredFiles.map(file => [file.path, file]))
      if (!sameInspectedManifest(verified.files, desiredManifest)) {
        return conflictForMutation(
          target.skillDirectory,
          verified.files,
          'The provider package does not match the reviewed snapshot after publication.',
        )
      }
      return {
        ok: true,
        materialization: {
          skillId: operation.skillId,
          targetId: operation.targetId,
          path: operation.path,
          snapshotDigest: operation.desiredSnapshotDigest!,
          files: operation.desiredFiles,
        },
      }
    } catch (error) {
      return {
        ok: false,
        kind: 'error',
        message: error instanceof Error ? error.message : 'Unknown installed skill filesystem error',
      }
    }
  }

  private async removeOwnedFile(
    packageRoot: string,
    file: AgentCodeInstalledSkillFileRecord,
    operationId: string,
  ): Promise<InstalledPackageMutationResult> {
    const path = packageFilePath(packageRoot, file.path)
    const quarantine = journalTemporaryPath(path, operationId)
    const recovered = await this.pathSafety.recoverJournaledDelete(
      path,
      quarantine,
      file.sha256,
      AGENT_CODE_INSTALLED_SKILL_MAX_FILE_BYTES,
    )
    if (recovered === 'conflict') {
      return { ok: false, kind: 'conflict', message: `Could not safely recover removal of ${file.path}.` }
    }
    if (recovered === 'completed') return { ok: true, materialization: null }
    const inspected = await this.pathSafety.inspectExactFile(
      path,
      AGENT_CODE_INSTALLED_SKILL_MAX_FILE_BYTES,
    )
    if (inspected.kind === 'missing') return { ok: true, materialization: null }
    if (inspected.kind !== 'file' || inspected.sha256 !== file.sha256) {
      return {
        ok: false,
        kind: 'conflict',
        message: `External changes were preserved in ${file.path}.`,
        fingerprint: inspected.fingerprint,
      }
    }
    const result = await this.pathSafety.unlinkOwnedRegularFile(
      path,
      inspected.version,
      file.sha256,
      quarantine,
      AGENT_CODE_INSTALLED_SKILL_MAX_FILE_BYTES,
    )
    if (result === 'changed') {
      return {
        ok: false,
        kind: 'conflict',
        message: `${file.path} changed immediately before removal and was preserved.`,
        fingerprint: inspected.fingerprint,
      }
    }
    return { ok: true, materialization: null }
  }

  private async inspectPackage(directory: string): Promise<InspectedPackage> {
    try {
      if (!isAbsolute(directory)) throw new Error('Installed package target is not absolute')
      await this.pathSafety.assertNoSymlinkComponents(directory)
      const stat = await lstat(directory).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      if (!stat) return { kind: 'files', files: new Map() }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        return conflictForPath(directory, 'The installed skill destination is not a regular directory.')
      }
      const paths = await walkPackageFiles(directory)
      const files = new Map<string, InspectedPackageFile>()
      for (const relativePath of paths) {
        const inspected = await this.pathSafety.inspectExactFile(
          packageFilePath(directory, relativePath),
          AGENT_CODE_INSTALLED_SKILL_MAX_FILE_BYTES,
        )
        if (inspected.kind !== 'file' || inspected.sha256 === null) {
          return {
            kind: 'conflict',
            message: inspected.kind === 'conflict'
              ? inspected.message
              : `Could not safely read ${relativePath}.`,
            fingerprint: inspected.kind === 'missing'
              ? createHash('sha256').update(`${directory}\0${relativePath}\0missing`).digest('hex')
              : inspected.fingerprint,
          }
        }
        files.set(relativePath, {
          path: relativePath,
          bytes: inspected.bytes,
          sha256: inspected.sha256,
          executable: inspected.executable,
          version: inspected.version,
        })
      }
      return { kind: 'files', files }
    } catch (error) {
      return conflictForPath(
        directory,
        error instanceof Error ? error.message : 'Could not inspect the installed skill destination.',
      )
    }
  }
}

async function walkPackageFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (!isSafeAgentCodeInstalledSkillPath(relativePath)) throw new Error('The package contains an unsafe path')
      if (entry.isSymbolicLink()) throw new Error(`The package contains a symbolic link: ${relativePath}`)
      if (entry.isDirectory()) await visit(join(directory, entry.name), relativePath)
      else if (entry.isFile()) files.push(relativePath)
      else throw new Error(`The package contains a non-regular object: ${relativePath}`)
      if (files.length > AGENT_CODE_INSTALLED_SKILL_MAX_FILES) {
        throw new Error('The package contains too many files')
      }
    }
  }
  await visit(root, '')
  return files.sort()
}

async function ensureNestedDirectory(packageRoot: string, filePath: string): Promise<void> {
  const parent = resolve(filePath, '..')
  const fromRoot = relative(resolve(packageRoot), parent)
  if (fromRoot.startsWith(`..${sep}`) || fromRoot === '..' || isAbsolute(fromRoot)) {
    throw new Error('Installed package file escaped its provider root')
  }
  let cursor = resolve(packageRoot)
  for (const segment of fromRoot.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment)
    try {
      await mkdir(cursor, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const stat = await lstat(cursor)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Installed package directory changed during publication')
    }
  }
}

function packageFilePath(root: string, relativePath: string): string {
  if (!isSafeAgentCodeInstalledSkillPath(relativePath)) throw new Error('Unsafe installed package path')
  const path = resolve(root, ...relativePath.split('/'))
  const fromRoot = relative(resolve(root), path)
  if (!fromRoot || fromRoot.startsWith(`..${sep}`) || fromRoot === '..' || isAbsolute(fromRoot)) {
    throw new Error('Installed package path escaped its provider root')
  }
  return path
}

function sameInspectedManifest(
  actual: Map<string, InspectedPackageFile>,
  expected: Map<string, AgentCodeInstalledSkillFileRecord>,
): boolean {
  if (actual.size !== expected.size) return false
  for (const [path, file] of actual) {
    const wanted = expected.get(path)
    if (!wanted || wanted.sha256 !== file.sha256 || wanted.bytes !== file.bytes
      || wanted.executable !== file.executable) return false
  }
  return true
}

function matchesManifestFile(
  actual: InspectedPackageFile,
  expected: AgentCodeInstalledSkillFileRecord | undefined,
): boolean {
  return expected !== undefined
    && actual.sha256 === expected.sha256
    && actual.bytes === expected.bytes
    && actual.executable === expected.executable
}

function conflictForMutation(
  directory: string,
  files: Map<string, InspectedPackageFile>,
  message: string,
): Extract<InstalledPackageMutationResult, { ok: false }> {
  return { ok: false, kind: 'conflict', message, fingerprint: packageFingerprint(directory, files) }
}

function conflictForFiles(
  directory: string,
  files: Map<string, InspectedPackageFile>,
  message: string,
): Extract<InstalledPackagePreflight, { kind: 'conflict' }> {
  return { kind: 'conflict', message, fingerprint: packageFingerprint(directory, files) }
}

function conflictForPath(
  path: string,
  message: string,
): Extract<InspectedPackage, { kind: 'conflict' }> {
  return {
    kind: 'conflict',
    message,
    fingerprint: createHash('sha256').update(`${path}\0${message}`).digest('hex'),
  }
}

function packageFingerprint(directory: string, files: Map<string, InspectedPackageFile>): string {
  const hash = createHash('sha256').update(directory).update('\0')
  for (const [path, file] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(path).update('\0').update(file.version).update('\0')
  }
  return hash.digest('hex')
}
