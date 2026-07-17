import { constants, type Stats } from 'fs'
import { link, lstat, open, rename, unlink } from 'fs/promises'
import { basename, dirname, join } from 'path'

import type { EditorFsFileVersion } from '@shared/types/editorFs.js'

const NO_FOLLOW = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
const pendingFileMutations = new Map<string, Promise<void>>()

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
  const handle = await open(absolutePath, constants.O_RDONLY | NO_FOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new Error('not a file')
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
      text: buffer.subarray(0, offset).toString('utf8'),
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
}): Promise<AtomicTextWriteResult> {
  const bytes = Buffer.from(params.text, 'utf8')
  if (bytes.byteLength > params.maxBytes) throw new Error('file is too large')

  const before = await existingRegularFile(params.absolutePath)
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

  const tempPath = join(
    dirname(params.absolutePath),
    `.${basename(params.absolutePath)}.agent-code-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.tmp`,
  )
  let tempExists = false
  try {
    const temp = await open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      before?.mode ?? 0o600,
    )
    tempExists = true
    try {
      // open(2)'s mode is filtered through the process umask. An editor save
      // must not silently strip executable/group bits from the file it
      // replaces, so restore the observed permission bits explicitly on the
      // already-private temporary descriptor before publishing it.
      if (before) await temp.chmod(before.mode)
      await temp.writeFile(bytes)
      await temp.sync()
    } finally {
      await temp.close()
    }

    const current = await existingRegularFile(params.absolutePath)
    if (typeof params.expectedVersion === 'string') {
      if (!current) return { ok: false, conflictKind: 'deleted' }
      if (editorFileVersion(current) !== params.expectedVersion) {
        return { ok: false, conflictKind: 'changed' }
      }
    }

    if (current) {
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
  }
}
