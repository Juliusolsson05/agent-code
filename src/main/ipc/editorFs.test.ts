import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import { renameWithoutClobber, resolveInsideRoot, validateExistingTarget } from './editorFs.js'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('editor filesystem containment', () => {
  it('resolves only project-relative paths', () => {
    const root = resolve('/repo')
    expect(resolveInsideRoot(root, 'src/file.ts')).toBe(resolve(root, 'src/file.ts'))
    expect(resolveInsideRoot(root, '')).toBe(root)

    for (const path of [
      '../outside',
      '/absolute',
      'C:\\absolute',
      '\\\\server\\share',
      'src/\0file',
    ]) {
      expect(() => resolveInsideRoot(root, path)).toThrow()
    }
  })

  it.skipIf(process.platform === 'win32')(
    'rejects leaf and intermediate symlink escapes',
    async () => {
      const base = await mkdtemp(join(tmpdir(), 'agent-code-editor-containment-'))
      tempRoots.push(base)
      const root = join(base, 'root')
      const outside = join(base, 'outside')
      await mkdir(root)
      await mkdir(outside)
      await writeFile(join(outside, 'secret.txt'), 'secret')
      await symlink(join(outside, 'secret.txt'), join(root, 'leaf-link'))
      await symlink(outside, join(root, 'directory-link'))

      await expect(validateExistingTarget(root, join(root, 'leaf-link'))).rejects.toThrow(
        'symbolic links',
      )
      await expect(
        validateExistingTarget(root, join(root, 'directory-link', 'secret.txt')),
      ).rejects.toThrow('escapes project root')
    },
  )
})

describe('editor filesystem rename', () => {
  it('never replaces an existing regular-file destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-code-editor-rename-'))
    tempRoots.push(root)
    const source = join(root, 'source.txt')
    const destination = join(root, 'destination.txt')
    await writeFile(source, 'source')
    await writeFile(destination, 'destination')

    await expect(renameWithoutClobber(source, destination)).rejects.toThrow('already exists')
    await expect(readFile(source, 'utf8')).resolves.toBe('source')
    await expect(readFile(destination, 'utf8')).resolves.toBe('destination')
  })

  it('supports case-only regular-file renames without clobbering another inode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-code-editor-rename-'))
    tempRoots.push(root)
    const source = join(root, 'Example.txt')
    const destination = join(root, 'example.txt')
    await writeFile(source, 'content')

    await renameWithoutClobber(source, destination)

    await expect(readFile(destination, 'utf8')).resolves.toBe('content')
    expect(await readdir(root)).toContain('example.txt')
    expect(await readdir(root)).not.toContain('Example.txt')
  })
})
