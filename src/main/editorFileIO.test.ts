import { chmod, lstat, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  atomicWriteTextFile,
  editorFileVersion,
  readBoundedTextFile,
  serializeEditorFileMutation,
} from './editorFileIO.js'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function tempFile(text = 'initial'): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'agent-code-editor-file-io-'))
  tempRoots.push(root)
  const path = join(root, 'file.txt')
  await writeFile(path, text)
  return { root, path }
}

describe('editor file IO', () => {
  it('reads through a fixed byte bound and rejects oversized files', async () => {
    const { path } = await tempFile('12345')

    await expect(readBoundedTextFile(path, 4)).rejects.toThrow('file is too large')
    await expect(readBoundedTextFile(path, 5)).resolves.toMatchObject({
      text: '12345',
    })
  })

  it('rejects binary and malformed UTF-8 instead of creating corruptible text', async () => {
    const { path } = await tempFile()
    await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]))
    await expect(readBoundedTextFile(path, 100)).rejects.toThrow('binary files are not supported')

    await writeFile(path, Buffer.from([0xc3, 0x28]))
    await expect(readBoundedTextFile(path, 100)).rejects.toThrow('not valid UTF-8')
  })

  it('preserves a UTF-8 BOM through the text read/write round trip', async () => {
    const { path } = await tempFile()
    const original = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('const value = 1\n')])
    await writeFile(path, original)
    const read = await readBoundedTextFile(path, 100)
    expect(read.text.startsWith('\ufeff')).toBe(true)

    await atomicWriteTextFile({
      absolutePath: path,
      text: read.text,
      expectedVersion: read.version,
      maxBytes: 100,
    })
    await expect(readFile(path)).resolves.toEqual(original)
  })

  it.skipIf(process.platform === 'win32')('does not follow a symbolic-link leaf', async () => {
    const { root, path } = await tempFile('outside')
    const linked = join(root, 'linked.txt')
    await symlink(path, linked)

    await expect(readBoundedTextFile(linked, 100)).rejects.toBeDefined()
  })

  it('atomically replaces the expected version and preserves file mode', async () => {
    const { path } = await tempFile('before')
    await chmod(path, 0o640)
    const before = await lstat(path)

    const result = await atomicWriteTextFile({
      absolutePath: path,
      text: 'after',
      expectedVersion: editorFileVersion(before),
      maxBytes: 100,
    })

    expect(result.ok).toBe(true)
    await expect(readFile(path, 'utf8')).resolves.toBe('after')
    expect((await lstat(path)).mode & 0o777).toBe(0o640)
  })

  it('fails closed on changed and deleted expected versions', async () => {
    const { path } = await tempFile('baseline')
    const expectedVersion = editorFileVersion(await lstat(path))
    await writeFile(path, 'external change')

    await expect(
      atomicWriteTextFile({
        absolutePath: path,
        text: 'editor change',
        expectedVersion,
        maxBytes: 100,
      }),
    ).resolves.toEqual({ ok: false, conflictKind: 'changed' })
    await expect(readFile(path, 'utf8')).resolves.toBe('external change')

    const latestVersion = editorFileVersion(await lstat(path))
    await unlink(path)
    await expect(
      atomicWriteTextFile({
        absolutePath: path,
        text: 'editor change',
        expectedVersion: latestVersion,
        maxBytes: 100,
      }),
    ).resolves.toEqual({ ok: false, conflictKind: 'deleted' })
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('serializes mutations for the same physical path', async () => {
    const { path } = await tempFile()
    const order: string[] = []
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const gate = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    const firstStarted = new Promise<void>(resolve => {
      markFirstStarted = resolve
    })
    const first = serializeEditorFileMutation(path, async () => {
      order.push('first:start')
      markFirstStarted()
      await gate
      order.push('first:end')
    })
    const second = serializeEditorFileMutation(path, async () => {
      order.push('second:start')
    })

    await firstStarted
    expect(order).toEqual(['first:start'])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second:start'])
  })
})
