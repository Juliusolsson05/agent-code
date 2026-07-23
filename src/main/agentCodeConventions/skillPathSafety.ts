import type { Stats } from 'fs'
import { link, lstat, mkdir, readdir, realpath, rename, rmdir, unlink } from 'fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'path'

import {
  editorFileVersion,
  readBoundedTextFile,
} from '@main/editorFileIO.js'
import {
  AGENT_CODE_CONVENTIONS_COLLISION_MAX_BYTES,
} from '@shared/types/agentCodeConventions.js'
import { sha256Text } from './renderSkill.js'
import type { AgentCodeConventionsTarget } from './targets.js'

export type FileInspection =
  | {
      kind: 'missing'
      directoryExists: boolean
      directoryEmpty: boolean
    }
  | {
      kind: 'file'
      sha256: string | null
      version: string
      fingerprint: string
      readError?: string
    }
  | { kind: 'conflict'; fingerprint: string; message: string }

export type OwnedUnlinkResult = 'deleted' | 'missing' | 'changed'
export type DeleteQuarantineRecovery = 'none' | 'completed' | 'restored' | 'conflict'

function directoryIdentity(stat: Stats): string {
  // Directory mtime/ctime change when the generated file or temp sibling is
  // published. Device+inode instead identifies replacement of the directory
  // itself, which is the ownership question this token answers.
  return `${stat.dev}:${stat.ino}`
}

export function journalTemporaryPath(filePath: string, operationId: string): string {
  // The operation id is hashed rather than interpolated. State is parsed from
  // disk and therefore must never be able to smuggle separators or dot-dot
  // components into a deletion-authorized temporary path.
  const operationKey = sha256Text(operationId).slice(0, 32)
  return join(dirname(filePath), `.${basename(filePath)}.agent-code-conventions-${operationKey}.tmp`)
}

/**
 * Owns the filesystem trust boundary for generated personal-skill paths.
 *
 * WHY this is a separate, single-consumer module: provider discovery says
 * where a skill belongs, while this class decides whether that path can be
 * inspected, created, or removed without following links. Keeping those rules
 * together prevents later provider/UI work from growing a second, subtly
 * different ownership policy inside the reconciliation state machine.
 */
export class SkillPathSafety {
  constructor(private readonly homeDirectory: string) {}

  async inspectTarget(target: AgentCodeConventionsTarget): Promise<FileInspection> {
    try {
      await this.assertNoSymlinkComponents(target.skillsDirectory)
      const directory = await lstat(target.skillDirectory).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      if (!directory) return { kind: 'missing', directoryExists: false, directoryEmpty: true }
      if (directory.isSymbolicLink() || !directory.isDirectory()) {
        return this.pathConflict(target.skillDirectory, 'The skill path is not a regular directory.')
      }
      const entries = await readdir(target.skillDirectory)
      const file = await lstat(target.skillFile).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      if (!file) {
        if (entries.length > 0) {
          return {
            kind: 'conflict',
            fingerprint: sha256Text(`${target.skillDirectory}\0${entries.sort().join('\0')}`),
            message: 'The skill directory contains files Agent Code does not own.',
          }
        }
        return { kind: 'missing', directoryExists: true, directoryEmpty: true }
      }
      return this.inspectRegularFile(target.skillFile, file)
    } catch (error) {
      return this.pathConflict(target.skillFile, safeErrorMessage(error))
    }
  }

  async inspectExactFile(path: string): Promise<FileInspection> {
    if (!isAbsolute(path)) return this.pathConflict(path, 'Persisted ownership path is not absolute.')
    try {
      await this.assertNoSymlinkComponents(dirname(path))
    } catch (error) {
      return this.pathConflict(path, safeErrorMessage(error))
    }
    const file = await lstat(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (!file) return { kind: 'missing', directoryExists: false, directoryEmpty: true }
    return this.inspectRegularFile(path, file)
  }

  async ensureTargetDirectory(target: AgentCodeConventionsTarget): Promise<{
    created: boolean
    identity: string
  }> {
    await this.ensureDirectoryTreeNoSymlinks(target.skillsDirectory)
    let created = false
    try {
      await mkdir(target.skillDirectory, { mode: 0o700 })
      created = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    await this.assertNoSymlinkComponents(target.skillDirectory)
    const canonical = await realpath(target.skillDirectory)
    const trustedHome = resolve(this.homeDirectory)
    const fromHome = relative(trustedHome, resolve(target.skillDirectory))
    const expectedCanonical = fromHome === ''
      || (!fromHome.startsWith(`..${sep}`) && fromHome !== '..' && !isAbsolute(fromHome))
      ? resolve(await realpath(trustedHome).catch(() => trustedHome), fromHome)
      : resolve(target.skillDirectory)
    if (resolve(canonical) !== expectedCanonical) {
      throw new Error('Symbolic-link skill directories are not supported')
    }
    const directory = await lstat(target.skillDirectory)
    if (directory.isSymbolicLink() || !directory.isDirectory()) {
      throw new Error('The skill path is not a regular directory')
    }
    return { created, identity: directoryIdentity(directory) }
  }

  async currentDirectoryIdentity(path: string): Promise<string | null> {
    await this.assertNoSymlinkComponents(dirname(path))
    const stat = await lstat(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (!stat) return null
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null
    return directoryIdentity(stat)
  }

  async cleanupJournaledTemporaryFile(path: string): Promise<void> {
    await this.assertNoSymlinkComponents(dirname(path))
    const stat = await lstat(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (!stat) return
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('Journaled temporary path is not a regular file')
    }
    // The pending operation authorizes this exact, operation-derived sibling.
    // It is intentionally the only sidecar we ever clean; directory scans and
    // marker bytes are not ownership evidence.
    await unlink(path)
  }

  async recoverJournaledDelete(
    path: string,
    quarantinePath: string,
    expectedSha256: string,
  ): Promise<DeleteQuarantineRecovery> {
    this.assertSibling(path, quarantinePath)
    const quarantined = await this.inspectExactFile(quarantinePath)
    if (quarantined.kind === 'missing') return 'none'
    if (quarantined.kind !== 'file' || quarantined.sha256 === null) return 'conflict'
    const targetExists = await lstat(path).then(() => true).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    })
    if (quarantined.sha256 === expectedSha256) {
      // A crash may land after rename captured the owned inode but before its
      // final unlink. The journal authorizes this exact derived sibling, and
      // its bytes still match the persisted ownership hash.
      await unlink(quarantinePath)
      return targetExists ? 'none' : 'completed'
    }
    if (targetExists) return 'conflict'
    const restored = await this.restoreQuarantine(quarantinePath, path)
    return restored ? 'restored' : 'conflict'
  }

  async unlinkOwnedRegularFile(
    path: string,
    expectedVersion: string,
    expectedSha256: string,
    quarantinePath: string,
  ): Promise<OwnedUnlinkResult> {
    this.assertSibling(path, quarantinePath)
    await this.assertNoSymlinkComponents(dirname(path))
    const quarantine = await lstat(quarantinePath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (quarantine) throw new Error('Journaled delete quarantine already exists')
    const current = await lstat(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (!current) return 'missing'
    if (current.isSymbolicLink() || !current.isFile()
      || editorFileVersion(current) !== expectedVersion) return 'changed'
    // Rename first captures whichever inode the path names at mutation time.
    // We verify the captured bytes before deleting them, so a replacement in
    // the lstat→rename window is restored rather than destroyed.
    await rename(path, quarantinePath)
    const captured = await this.inspectExactFile(quarantinePath)
    if (captured.kind !== 'file' || captured.sha256 !== expectedSha256) {
      if (!await this.restoreQuarantine(quarantinePath, path)) {
        throw new Error('Captured file changed and could not be restored without clobbering')
      }
      return 'changed'
    }
    await unlink(quarantinePath)
    return 'deleted'
  }

  async removeEmptyOwnedDirectory(path: string, expectedIdentity?: string): Promise<boolean> {
    if (!expectedIdentity) return false
    await this.assertNoSymlinkComponents(dirname(path))
    const current = await lstat(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (!current) return true
    if (current.isSymbolicLink() || !current.isDirectory()
      || directoryIdentity(current) !== expectedIdentity) return false
    try {
      await rmdir(path)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY') return false
      throw error
    }
  }

  async assertNoSymlinkComponents(path: string): Promise<void> {
    const { cursor: initialCursor, segments } = this.pathWalk(path)
    let cursor = initialCursor
    for (const segment of segments) {
      cursor = join(cursor, segment)
      const stat = await lstat(cursor).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      if (!stat) return
      if (stat.isSymbolicLink()) throw new Error(`Symbolic-link path component is not supported: ${cursor}`)
      if (!stat.isDirectory()) throw new Error(`Path component is not a directory: ${cursor}`)
    }
  }

  private async inspectRegularFile(path: string, stat: Stats): Promise<FileInspection> {
    const version = editorFileVersion(stat)
    const fingerprint = sha256Text(`${path}\0${version}`)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { kind: 'conflict', fingerprint, message: 'The target is not a regular file.' }
    }
    try {
      const read = await readBoundedTextFile(path, AGENT_CODE_CONVENTIONS_COLLISION_MAX_BYTES)
      return {
        kind: 'file',
        sha256: sha256Text(read.text),
        version: read.version,
        fingerprint: sha256Text(`${path}\0${read.version}`),
      }
    } catch (error) {
      return {
        kind: 'file',
        sha256: null,
        version,
        fingerprint,
        readError: safeErrorMessage(error),
      }
    }
  }

  private pathConflict(path: string, message: string): FileInspection {
    return {
      kind: 'conflict',
      fingerprint: sha256Text(`${path}\0${message}`),
      message,
    }
  }

  private assertSibling(path: string, sibling: string): void {
    if (resolve(dirname(path)) !== resolve(dirname(sibling)) || resolve(path) === resolve(sibling)) {
      throw new Error('Journaled filesystem path must be a distinct target sibling')
    }
  }

  private async restoreQuarantine(quarantinePath: string, path: string): Promise<boolean> {
    try {
      // Hard-link recreation is the portable atomic no-clobber operation. If a
      // new external file already occupies the target, preserve both paths and
      // surface a conflict rather than overwriting either one.
      await link(quarantinePath, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
    await unlink(quarantinePath)
    return true
  }

  private async ensureDirectoryTreeNoSymlinks(path: string): Promise<void> {
    const { cursor: initialCursor, segments } = this.pathWalk(path)
    let cursor = initialCursor
    for (const segment of segments) {
      cursor = join(cursor, segment)
      let stat = await lstat(cursor).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      if (!stat) {
        try {
          // Creating one component at a time prevents mkdir({recursive:true})
          // from silently following a symlink hidden in an otherwise missing
          // provider path. EEXIST is a race signal, not success: re-lstat below.
          await mkdir(cursor, { mode: 0o700 })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
        stat = await lstat(cursor)
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`Symbolic-link path component is not supported: ${cursor}`)
      }
      if (!stat.isDirectory()) throw new Error(`Path component is not a directory: ${cursor}`)
    }
  }

  private pathWalk(path: string): { cursor: string; segments: string[] } {
    const absolute = resolve(path)
    const trustedHome = resolve(this.homeDirectory)
    const fromHome = relative(trustedHome, absolute)
    if (fromHome === '' || (!fromHome.startsWith(`..${sep}`) && fromHome !== '..' && !isAbsolute(fromHome))) {
      // The effective home is inherited from the same environment as provider
      // processes, so it is the trust anchor. Rejecting symlinks above it would
      // incorrectly reject macOS /var-backed temporary homes and user accounts
      // reached through an administrator-chosen mount alias; provider-owned
      // components below home remain fully checked.
      return { cursor: trustedHome, segments: fromHome.split(sep).filter(Boolean) }
    }
    const root = parse(absolute).root
    return {
      cursor: root,
      segments: absolute.slice(root.length).split(sep).filter(Boolean),
    }
  }
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return 'Unknown filesystem error'
}
