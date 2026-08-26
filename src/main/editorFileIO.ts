import { constants, type Stats } from 'fs'
import { createHash } from 'crypto'
import { link, lstat, mkdir, open, rename, rmdir, unlink } from 'fs/promises'
import { basename, dirname, join, resolve } from 'path'

import type { EditorFsFileVersion } from '@shared/types/editorFs.js'

const NO_FOLLOW = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
// A malicious or accidental FIFO must not make an awaited startup read block
// forever before fstat can reject it. O_NONBLOCK is inert for regular files and
// gives every bounded-reader caller the same non-regular-file fail-closed rule.
const NON_BLOCK = process.platform === 'win32' ? 0 : constants.O_NONBLOCK
const pendingFileMutations = new Map<string, Promise<void>>()
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function decodeEditorText(buffer: Buffer): string {
  // Buffer.toString silently replaces malformed byte sequences with U+FFFD;
  // saving that model then permanently rewrites arbitrary binary bytes as
  // UTF-8. A code editor must fail before presenting a corruptible illusion of
  // text. NUL additionally catches UTF-16 and many valid-UTF-8 binary formats.
  if (buffer.includes(0)) throw new Error('binary files are not supported')
  try {
    return utf8Decoder.decode(buffer)
  } catch {
    throw new Error('file is not valid UTF-8 text')
  }
}

export function editorFileVersion(stat: Stats): EditorFsFileVersion {
  // mtime alone is not a version: tools can restore timestamps, and some
  // filesystems expose coarse mtimes. Device/inode catch replacement while
  // ctime/size catch same-path edits. The string is deliberately opaque across
  // IPC so this representation can evolve without renderer migrations.
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')
}

export async function serializeEditorFileMutation<T>(
  absolutePath: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = pendingFileMutations.get(absolutePath) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => {
    release = resolve
  })
  pendingFileMutations.set(absolutePath, current)
  await previous.catch(() => undefined)
  try {
    return await task()
  } finally {
    release()
    if (pendingFileMutations.get(absolutePath) === current) {
      pendingFileMutations.delete(absolutePath)
    }
  }
}

export async function readBoundedTextFile(
  absolutePath: string,
  maxBytes: number,
): Promise<{
  text: string
  stat: Stats
  version: EditorFsFileVersion
}> {
  // O_NOFOLLOW is unavailable on Windows. The lstat/open/lstat sandwich does
  // not claim to be a kernel-level no-follow primitive, but it does reject the
  // stable reparse-point case and detects a path swap around open. POSIX keeps
  // O_NOFOLLOW as the stronger final guard.
  const pathBefore = await lstat(absolutePath)
  if (pathBefore.isSymbolicLink()) throw new Error('symbolic links are not supported')
  if (!pathBefore.isFile()) throw new Error('not a file')
  const handle = await open(absolutePath, constants.O_RDONLY | NO_FOLLOW | NON_BLOCK)
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new Error('not a file')
    const pathAfterOpen = await lstat(absolutePath)
    if (pathAfterOpen.isSymbolicLink() || !pathAfterOpen.isFile()) {
      throw new Error('file path changed while it was being opened')
    }
    if (editorFileVersion(pathBefore) !== editorFileVersion(pathAfterOpen)
      || editorFileVersion(before) !== editorFileVersion(pathAfterOpen)) {
      throw new Error('file changed while it was being opened')
    }
    // Allocate the bound, not the pre-read stat size. A file can grow after
    // fstat; handle.readFile() would then allocate the unbounded new size before
    // our later consistency check got a chance to reject it.
    const buffer = Buffer.allocUnsafe(maxBytes + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > maxBytes) throw new Error('file is too large')
    const after = await handle.stat()
    const beforeVersion = editorFileVersion(before)
    const afterVersion = editorFileVersion(after)
    if (beforeVersion !== afterVersion) throw new Error('file changed while it was being read')
    return {
      text: decodeEditorText(buffer.subarray(0, offset)),
      stat: after,
      version: afterVersion,
    }
  } finally {
    await handle.close()
  }
}

export type AtomicTextWriteResult =
  | { ok: true; stat: Stats; version: EditorFsFileVersion }
  | { ok: false; conflictKind: 'changed' | 'deleted' }

async function existingRegularFile(path: string): Promise<Stats | null> {
  const value = await lstat(path).catch(err => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  })
  if (!value) return null
  if (value.isSymbolicLink()) throw new Error('symbolic links are not supported')
  if (!value.isFile()) throw new Error('not a file')
  return value
}

async function syncParentBestEffort(path: string): Promise<void> {
  // The file fsync makes its bytes durable; syncing the directory makes the
  // rename/link durable too. Windows and some network filesystems reject
  // directory handles, so this is the one best-effort step rather than making a
  // successful safe replacement look failed after it has already happened.
  const handle = await open(dirname(path), constants.O_RDONLY).catch(() => null)
  if (!handle) return
  try {
    await handle.sync().catch(() => undefined)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

export async function atomicWriteTextFile(params: {
  absolutePath: string
  text: string
  expectedVersion?: EditorFsFileVersion | null
  maxBytes: number
  mode?: number
  temporaryPath?: string
  captureDirectory?: string
  expectedSha256?: string
}): Promise<AtomicTextWriteResult> {
  const bytes = Buffer.from(params.text, 'utf8')
  if (bytes.byteLength > params.maxBytes) throw new Error('file is too large')

  const before = await existingRegularFile(params.absolutePath)
  // `null` is an explicit create-only expectation used by deleted-buffer
  // recreation and conventions publication. Treating it like `undefined`
  // would let a file created after preflight be silently replaced.
  if (before && params.expectedVersion === null) {
    return { ok: false, conflictKind: 'changed' }
  }
  if (!before && typeof params.expectedVersion === 'string') {
    return { ok: false, conflictKind: 'deleted' }
  }
  const beforeVersion = before ? editorFileVersion(before) : null
  if (
    beforeVersion &&
    typeof params.expectedVersion === 'string' &&
    beforeVersion !== params.expectedVersion
  ) {
    return { ok: false, conflictKind: 'changed' }
  }

  const tempPath = params.temporaryPath ?? join(
    dirname(params.absolutePath),
    `.${basename(params.absolutePath)}.agent-code-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.tmp`,
  )
  if (resolve(dirname(tempPath)) !== resolve(dirname(params.absolutePath))
    || resolve(tempPath) === resolve(params.absolutePath)) {
    throw new Error('temporary path must be a distinct sibling of the target')
  }
  if (params.captureDirectory
    && (resolve(dirname(params.captureDirectory)) !== resolve(dirname(params.absolutePath))
      || resolve(params.captureDirectory) === resolve(params.absolutePath)
      || resolve(params.captureDirectory) === resolve(tempPath))) {
    throw new Error('capture directory must be a distinct sibling of the target')
  }
  let tempExists = false
  let captureFilePath: string | null = null
  let captureContainsExpectedFile = false
  try {
    const temp = await open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      params.mode ?? before?.mode ?? 0o600,
    )
    tempExists = true
    try {
      // open(2)'s mode is filtered through the process umask. An editor save
      // must not silently strip executable/group bits from the file it
      // replaces, so restore the observed permission bits explicitly on the
      // already-private temporary descriptor before publishing it.
      if (params.mode !== undefined) await temp.chmod(params.mode)
      else if (before) await temp.chmod(before.mode)
      await temp.writeFile(bytes)
      await temp.sync()
    } finally {
      await temp.close()
    }

    const current = await existingRegularFile(params.absolutePath)
    if (params.expectedVersion === null && current) {
      return { ok: false, conflictKind: 'changed' }
    }
    if (typeof params.expectedVersion === 'string') {
      if (!current) return { ok: false, conflictKind: 'deleted' }
      if (editorFileVersion(current) !== params.expectedVersion) {
        return { ok: false, conflictKind: 'changed' }
      }
    }

    if (current && params.captureDirectory) {
      if (typeof params.expectedVersion !== 'string') {
        return { ok: false, conflictKind: 'changed' }
      }
      try {
        await mkdir(params.captureDirectory, { mode: 0o700 })
      } catch (error) {
        // The write-ahead operation chooses this directory, but it does not
        // own a later occupant merely because the name matches. Refusing an
        // existing capture directory is what keeps recovery metadata from
        // becoming deletion or overwrite authority over external bytes.
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          return { ok: false, conflictKind: 'changed' }
        }
        throw error
      }
      captureFilePath = join(params.captureDirectory, basename(params.absolutePath))

      // There is no portable compare-and-swap rename for an existing file in
      // Node. Moving the currently named inode out of the way first lets us
      // verify what the mutation actually captured, then the hard-link publish
      // below gives a concurrent external creator the destination instead of
      // overwriting it. The operation-derived directory makes the capture
      // crash-visible without trusting an unverified sidecar as ours.
      await rename(params.absolutePath, captureFilePath)
      const captured = await existingRegularFile(captureFilePath)
      const capturedHash = captured && params.expectedSha256
        ? createHash('sha256')
            .update((await readBoundedTextFile(captureFilePath, params.maxBytes)).text)
            .digest('hex')
        : null
      // rename can legitimately advance ctime, so the opaque editor version
      // cannot survive capture byte-for-byte. Device/inode plus the content
      // hash prove that we moved the file observed by the final check; an
      // external replacement has a different inode or different bytes.
      captureContainsExpectedFile = captured !== null
        && captured.dev === current.dev
        && captured.ino === current.ino
        && captured.size === current.size
        && captured.mtimeMs === current.mtimeMs
        && (!params.expectedSha256 || capturedHash === params.expectedSha256)
      if (!captureContainsExpectedFile) {
        try {
          await link(captureFilePath, params.absolutePath)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error(`External replacement preserved at ${captureFilePath}`)
          }
          throw error
        }
        await unlink(captureFilePath)
        captureFilePath = null
        await rmdir(params.captureDirectory)
        return { ok: false, conflictKind: 'changed' }
      }

      try {
        await link(tempPath, params.absolutePath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          // The captured inode is the exact expected version, so dropping this
          // extra link cannot lose user data. The new destination belongs to
          // the external winner and must remain untouched.
          await unlink(captureFilePath)
          captureFilePath = null
          await rmdir(params.captureDirectory)
          return { ok: false, conflictKind: 'changed' }
        }
        throw error
      }
      await unlink(tempPath)
      tempExists = false
      await unlink(captureFilePath)
      captureFilePath = null
      await rmdir(params.captureDirectory)
    } else if (current) {
      // rename publishes the fully-synced sibling atomically over an existing
      // file. Portable Node cannot compare-and-swap against unrelated external
      // writers in the final lookup window; the version recheck above and the
      // shared in-process queue close every race Agent Code itself controls.
      await rename(tempPath, params.absolutePath)
      tempExists = false
    } else {
      // Publishing a newly recreated file via hard link is an atomic no-clobber
      // operation. A concurrent external creator wins with EEXIST instead of
      // having its bytes silently replaced by path-based rename.
      try {
        await link(tempPath, params.absolutePath)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          return { ok: false, conflictKind: 'changed' }
        }
        throw err
      }
      await unlink(tempPath)
      tempExists = false
    }
    await syncParentBestEffort(params.absolutePath)
    const after = await existingRegularFile(params.absolutePath)
    if (!after) throw new Error('file disappeared after save')
    return { ok: true, stat: after, version: editorFileVersion(after) }
  } finally {
    if (tempExists) await unlink(tempPath).catch(() => undefined)
    if (captureFilePath && captureContainsExpectedFile) {
      // Ordinary exceptions after capture must not make the expected file
      // disappear. A no-clobber restore yields to an external creator; in that
      // case the captured inode is the already-proven expected version and can
      // be removed without touching the winner.
      await link(captureFilePath, params.absolutePath).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      })
      await unlink(captureFilePath).catch(() => undefined)
      if (params.captureDirectory) await rmdir(params.captureDirectory).catch(() => undefined)
    }
  }
}
