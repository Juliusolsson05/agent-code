import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { serializeEditorFileMutation } from '@main/editorFileIO.js'

const authority = vi.hoisted(() => ({
  capabilities: vi.fn<() => Promise<string[]>>(),
  publish: undefined as undefined | ((rows: Array<{ manifest: { id: string }; installation: { id: string; bundleSha256: string }; sha256: string; version?: string }>) => void),
}))

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('./grants.js', () => ({
  installedExtensionCapabilities: authority.capabilities,
}))
vi.mock('./ledger.js', () => ({
  onExtensionPublication: (listener: typeof authority.publish) => {
    authority.publish = listener
    return () => { if (authority.publish === listener) authority.publish = undefined }
  },
}))

const {
  ExtensionCapabilityService,
  MAX_EXTENSION_TEXT_FILE_BYTES,
  MAX_EXTENSION_TEXT_WRITE_BYTES,
} = await import('./capabilityService.js')
const roots: string[] = []

async function fixture(): Promise<{ root: string; service: InstanceType<typeof ExtensionCapabilityService> }> {
  const root = await mkdtemp(join(tmpdir(), 'agent-code-extension-files-'))
  roots.push(root)
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'note.txt'), 'hello extension\n')
  authority.capabilities.mockResolvedValue(['fs.read', 'fs.write'])
  return {
    root,
    service: new ExtensionCapabilityService({
      resolveSessionRoot: sessionId => sessionId === 'live-session' ? root : null,
    }),
  }
}

afterEach(async () => {
  authority.capabilities.mockReset()
  authority.publish = undefined
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('scoped extension filesystem reads', () => {
  it('reads bounded UTF-8 through a session-derived project root and caches byte verification', async () => {
    const { service } = await fixture()
    try {
      await expect(service.invoke('reader', 'generation-one', {
        method: 'fs.readText', sessionId: 'live-session', path: 'src/note.txt',
      })).resolves.toMatchObject({
        sessionId: 'live-session', path: 'src/note.txt', text: 'hello extension\n', size: 16,
        version: expect.any(String),
      })
      authority.publish?.([
        { manifest: { id: 'reader' }, installation: { id: 'generation-one', bundleSha256: 'hash' }, sha256: 'hash' },
        { manifest: { id: 'theme-pack' }, installation: { id: 'new-theme', bundleSha256: 'hash' }, sha256: 'hash' },
      ])
      await service.invoke('reader', 'generation-one', {
        method: 'fs.readText', sessionId: 'live-session', path: 'src/note.txt',
      })
      // Full-bundle verification is intentionally shared within one immutable
      // generation; otherwise repeated small reads scale with bundle size.
      expect(authority.capabilities).toHaveBeenCalledOnce()
      expect(authority.capabilities).toHaveBeenCalledWith('reader', 'generation-one')
    } finally { service.dispose() }
  })

  it('atomically creates and replaces files without overwriting a stale version', async () => {
    const { root, service } = await fixture()
    try {
      const original = await service.invoke('writer', 'generation-one', {
        method: 'fs.readText', sessionId: 'live-session', path: 'src/note.txt',
      })
      if (!('text' in original)) throw new Error('Expected a file read')
      const written = await service.invoke('writer', 'generation-one', {
        method: 'fs.writeText', sessionId: 'live-session', path: 'src/note.txt',
        text: 'updated by extension\n', expectedVersion: original.version,
      })
      expect(written).toMatchObject({
        sessionId: 'live-session', path: 'src/note.txt', size: 21, version: expect.any(String),
      })
      expect(await readFile(join(root, 'src', 'note.txt'), 'utf8')).toBe('updated by extension\n')

      await expect(service.invoke('writer', 'generation-one', {
        method: 'fs.writeText', sessionId: 'live-session', path: 'src/note.txt',
        text: 'stale overwrite', expectedVersion: original.version,
      })).rejects.toThrow('changed after it was read')
      expect(await readFile(join(root, 'src', 'note.txt'), 'utf8')).toBe('updated by extension\n')

      await expect(service.invoke('writer', 'generation-one', {
        method: 'fs.writeText', sessionId: 'live-session', path: 'src/created.txt',
        text: 'created once', expectedVersion: null,
      })).resolves.toMatchObject({ path: 'src/created.txt', size: 12 })
      await expect(service.invoke('writer', 'generation-one', {
        method: 'fs.writeText', sessionId: 'live-session', path: 'src/created.txt',
        text: 'must not clobber', expectedVersion: null,
      })).rejects.toThrow('changed after it was read')
      expect(await readFile(join(root, 'src', 'created.txt'), 'utf8')).toBe('created once')
    } finally { service.dispose() }
  })

  it('serializes competing writers so one stale compare-and-swap loses without clobbering', async () => {
    const { root, service } = await fixture()
    try {
      const original = await service.invoke('writer', 'generation-one', {
        method: 'fs.readText', sessionId: 'live-session', path: 'src/note.txt',
      })
      if (!('text' in original)) throw new Error('Expected a file read')
      const results = await Promise.allSettled(['first', 'second'].map(text => service.invoke(
        'writer', 'generation-one', {
          method: 'fs.writeText', sessionId: 'live-session', path: 'src/note.txt',
          text, expectedVersion: original.version,
        },
      )))
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
      expect(['first', 'second']).toContain(await readFile(join(root, 'src', 'note.txt'), 'utf8'))
    } finally { service.dispose() }
  })

  it('rechecks generation authority after waiting for an editor mutation', async () => {
    const { root, service } = await fixture()
    const target = join(root, 'src', 'note.txt')
    let release!: () => void
    let entered!: () => void
    const holding = new Promise<void>(resolve => { release = resolve })
    const enteredQueue = new Promise<void>(resolve => { entered = resolve })
    const editorWrite = serializeEditorFileMutation(target, async () => {
      entered()
      await holding
    })
    await enteredQueue
    try {
      const original = await service.invoke('writer', 'generation-one', {
        method: 'fs.readText', sessionId: 'live-session', path: 'src/note.txt',
      })
      if (!('text' in original)) throw new Error('Expected a file read')
      const write = service.invoke('writer', 'generation-one', {
        method: 'fs.writeText', sessionId: 'live-session', path: 'src/note.txt',
        text: 'retired write', expectedVersion: original.version,
      })
      // Let the write finish preflight and take its place behind the editor's
      // held mutation before simulating an update that retires this generation.
      await new Promise(resolve => setImmediate(resolve))
      authority.publish?.([])
      release()
      await editorWrite
      await expect(write).rejects.toThrow('no longer active')
      expect(await readFile(target, 'utf8')).toBe('hello extension\n')
    } finally {
      release()
      await editorWrite
      service.dispose()
    }
  })

  it('rejects ungranted, escaped, non-text, oversized and invalid-target writes', async () => {
    const { service } = await fixture()
    try {
      authority.capabilities.mockResolvedValueOnce(['fs.read'])
      await expect(service.invoke('write-denied', 'generation-one', {
        method: 'fs.writeText', sessionId: 'live-session', path: 'src/denied.txt',
        text: 'denied', expectedVersion: null,
      })).rejects.toThrow('capability "fs.write" is not granted')

      const requests = [
        { path: '../outside.txt', text: 'nope', error: 'escapes project root' },
        { path: '/tmp/outside.txt', text: 'nope', error: 'relative to project root' },
        { path: 'missing/child.txt', text: 'nope', error: 'ENOENT' },
        { path: 'src', text: 'nope', error: 'not a file' },
        { path: 'src/nul.txt', text: 'bad\u0000text', error: 'valid UTF-8 text' },
        {
          path: 'src/large.txt', text: 'x'.repeat(MAX_EXTENSION_TEXT_WRITE_BYTES + 1),
          error: `limited to ${MAX_EXTENSION_TEXT_WRITE_BYTES} bytes`,
        },
      ]
      for (const request of requests) {
        await expect(service.invoke('writer', 'generation-one', {
          method: 'fs.writeText', sessionId: 'live-session', path: request.path,
          text: request.text, expectedVersion: null,
        })).rejects.toThrow(request.error)
      }
    } finally { service.dispose() }
  })

  it('rejects absent consent, inactive targets, traversal, binary data, directories and oversized files', async () => {
    const { root, service } = await fixture()
    try {
      authority.capabilities.mockResolvedValueOnce([])
      await expect(service.invoke('denied', 'generation-one', {
        method: 'fs.readText', sessionId: 'live-session', path: 'src/note.txt',
      })).rejects.toThrow('capability "fs.read" is not granted')

      const requests = [
        { sessionId: 'gone-session', path: 'src/note.txt', error: 'target session is not active' },
        { sessionId: 'live-session', path: '../outside.txt', error: 'escapes project root' },
        { sessionId: 'live-session', path: '/etc/passwd', error: 'relative to project root' },
        { sessionId: 'live-session', path: 'src', error: 'not a file' },
      ]
      for (const request of requests) {
        await expect(service.invoke('reader', 'generation-one', {
          method: 'fs.readText', sessionId: request.sessionId, path: request.path,
        })).rejects.toThrow(request.error)
      }
      await writeFile(join(root, 'binary.dat'), Buffer.from([0x89, 0x00, 0xff]))
      await expect(service.invoke('reader', 'generation-one', {
        method: 'fs.readText', sessionId: 'live-session', path: 'binary.dat',
      })).rejects.toThrow('binary files are not supported')
      await writeFile(join(root, 'large.txt'), 'x'.repeat(MAX_EXTENSION_TEXT_FILE_BYTES + 1))
      await expect(service.invoke('reader', 'generation-one', {
        method: 'fs.readText', sessionId: 'live-session', path: 'large.txt',
      })).rejects.toThrow(`limited to ${MAX_EXTENSION_TEXT_FILE_BYTES} bytes`)
    } finally { service.dispose() }
  })

  it.skipIf(process.platform === 'win32')('rejects leaf and intermediate symlink escapes', async () => {
    const { root, service } = await fixture()
    const outside = await mkdtemp(join(tmpdir(), 'agent-code-extension-files-outside-'))
    roots.push(outside)
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(join(outside, 'secret.txt'), join(root, 'leaf-link'))
    await symlink(outside, join(root, 'directory-link'))
    try {
      await expect(service.invoke('reader', 'generation-one', {
        method: 'fs.readText', sessionId: 'live-session', path: 'leaf-link',
      })).rejects.toThrow('symbolic links are not supported')
      await expect(service.invoke('reader', 'generation-one', {
        method: 'fs.readText', sessionId: 'live-session', path: 'directory-link/secret.txt',
      })).rejects.toThrow('escapes project root')
      await expect(service.invoke('reader', 'generation-one', {
        method: 'fs.writeText', sessionId: 'live-session', path: 'leaf-link',
        text: 'overwrite', expectedVersion: null,
      })).rejects.toThrow('symbolic links are not supported')
      await expect(service.invoke('reader', 'generation-one', {
        method: 'fs.writeText', sessionId: 'live-session', path: 'directory-link/new.txt',
        text: 'escape', expectedVersion: null,
      })).rejects.toThrow('escapes project root')
    } finally { service.dispose() }
  })

  it('invalidates an in-flight grant check at publication instead of caching stale consent', async () => {
    const { service } = await fixture()
    let resolveGrant!: (capabilities: string[]) => void
    authority.capabilities.mockReset()
    authority.capabilities.mockReturnValue(new Promise(resolve => { resolveGrant = resolve }))
    const pending = service.invoke('reader', 'generation-one', {
      method: 'fs.readText', sessionId: 'live-session', path: 'src/note.txt',
    })
    authority.publish?.([])
    resolveGrant(['fs.read'])
    await expect(pending).rejects.toThrow('no longer active')
    service.dispose()
  })
})
