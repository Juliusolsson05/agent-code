import { mkdtemp, mkdir, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import { resolveInsideRoot, validateExistingTarget } from './editorFs.js'

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
