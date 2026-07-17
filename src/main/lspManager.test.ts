import { describe, expect, it } from 'vitest'

import { LspManager } from './lspManager.js'

type TestDocument = {
  clientUri: string
  serverKey: string
  serverUri: string
  version: number
  language: string
  refs: number
}

type LspManagerInternals = {
  docs: Map<string, TestDocument>
  servers: Map<string, object>
  sendNotificationIfOpen: (server: object, method: string, params: unknown) => Promise<void>
}

describe('LspManager document ownership', () => {
  it('changes shared documents without consuming refs and closes only the last owner', async () => {
    const manager = new LspManager()
    const internal = manager as unknown as LspManagerInternals
    const server = {}
    const notifications: string[] = []
    internal.servers.set('server', server)
    internal.docs.set('file:///repo/file.ts', {
      clientUri: 'file:///repo/file.ts',
      serverKey: 'server',
      serverUri: 'file:///repo/file.ts',
      version: 1,
      language: 'typescript',
      refs: 2,
    })
    internal.sendNotificationIfOpen = async (_server, method) => {
      notifications.push(method)
    }

    await manager.changeDocument('file:///repo/file.ts', 'new text')
    expect(internal.docs.get('file:///repo/file.ts')).toMatchObject({ refs: 2, version: 2 })
    expect(notifications).toEqual(['textDocument/didChange'])

    await manager.closeDocument('file:///repo/file.ts')
    expect(internal.docs.get('file:///repo/file.ts')?.refs).toBe(1)
    expect(notifications).toEqual(['textDocument/didChange'])

    await manager.closeDocument('file:///repo/file.ts')
    expect(internal.docs.has('file:///repo/file.ts')).toBe(false)
    expect(notifications).toEqual(['textDocument/didChange', 'textDocument/didClose'])
  })
})
