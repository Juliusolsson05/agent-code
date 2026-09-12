import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

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

const { ExtensionCapabilityService, MAX_EXTENSION_TEXT_FILE_BYTES } = await import('./capabilityService.js')
const roots: string[] = []

async function fixture(): Promise<{ root: string; service: InstanceType<typeof ExtensionCapabilityService> }> {
  const root = await mkdtemp(join(tmpdir(), 'agent-code-extension-files-'))
  roots.push(root)
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'note.txt'), 'hello extension\n')
  authority.capabilities.mockResolvedValue(['fs.read'])
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
