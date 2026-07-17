import { describe, expect, it } from 'vitest'

import { LspManager } from './lspManager.js'

type TestDocument = {
  clientUri: string
  serverKey: string
  serverUri: string
  version: number
  language: string
  refs: number
  completionItems: Map<number, object>
}

type LspManagerInternals = {
  docs: Map<string, TestDocument>
  servers: Map<string, object>
  getOrCreateServer: () => Promise<object>
  sendNotificationIfOpen: (server: object, method: string, params: unknown) => Promise<void>
  sendDocRequest: (
    clientUri: string,
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>
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
      completionItems: new Map(),
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

  it('serializes a delayed open, change, and close for one client URI', async () => {
    const manager = new LspManager()
    const internal = manager as unknown as LspManagerInternals
    const server = {
      key: 'server',
      initialized: Promise.resolve({}),
      closed: false,
    }
    internal.servers.set('server', server)
    internal.getOrCreateServer = async () => server
    const notifications: string[] = []
    let releaseOpen!: () => void
    const openGate = new Promise<void>(resolve => {
      releaseOpen = resolve
    })
    internal.sendNotificationIfOpen = async (_server, method) => {
      notifications.push(method)
      if (method === 'textDocument/didOpen') await openGate
    }

    const params = {
      clientUri: 'file:///repo/queued.ts?buffer=1',
      content: 'initial',
      language: 'typescript',
      workspaceRoot: '/repo',
      filePath: 'queued.ts',
    }
    const opened = manager.openDocument(params)
    const changed = manager.changeDocument(params.clientUri, 'changed')
    const closed = manager.closeDocument(params.clientUri)

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(notifications).toEqual(['textDocument/didOpen'])
    releaseOpen()
    await Promise.all([opened, changed, closed])

    expect(notifications).toEqual([
      'textDocument/didOpen',
      'textDocument/didChange',
      'textDocument/didClose',
    ])
    expect(internal.docs.has(params.clientUri)).toBe(false)
  })

  it('resolves only main-owned completion items and returns deferred edits', async () => {
    const manager = new LspManager()
    const internal = manager as unknown as LspManagerInternals
    const rawItem = { label: 'readFile', kind: 3, data: { source: 'node:fs' } }
    const requests: Array<{ method: string; params: unknown }> = []
    const server = {
      closed: false,
      initialized: Promise.resolve({
        capabilities: { completionProvider: { resolveProvider: true } },
      }),
      connection: {
        sendRequest: async (method: string, params: unknown) => {
          requests.push({ method, params })
          return {
            ...rawItem,
            detail: 'Import from node:fs',
            additionalTextEdits: [
              {
                newText: "import { readFile } from 'node:fs'\n",
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 0 },
                },
              },
            ],
          }
        },
      },
    }
    internal.servers.set('server', server)
    internal.docs.set('file:///repo/file.ts', {
      clientUri: 'file:///repo/file.ts',
      serverKey: 'server',
      serverUri: 'file:///repo/file.ts',
      version: 1,
      language: 'typescript',
      refs: 1,
      completionItems: new Map([[7, rawItem]]),
    })

    await expect(manager.resolveCompletion('file:///repo/file.ts', 999)).resolves.toBeNull()
    await expect(manager.resolveCompletion('file:///repo/file.ts', 7)).resolves.toMatchObject({
      label: 'readFile',
      resolveId: 7,
      detail: 'Import from node:fs',
      additionalTextEdits: [
        {
          newText: "import { readFile } from 'node:fs'\n",
          startLine: 0,
          startCharacter: 0,
          endLine: 0,
          endCharacter: 0,
        },
      ],
    })
    expect(requests).toEqual([{ method: 'completionItem/resolve', params: rawItem }])
  })

  it('preserves completion trigger context and incomplete-list semantics', async () => {
    const manager = new LspManager()
    const internal = manager as unknown as LspManagerInternals
    const doc: TestDocument = {
      clientUri: 'file:///repo/file.ts',
      serverKey: 'server',
      serverUri: 'file:///repo/file.ts',
      version: 1,
      language: 'typescript',
      refs: 1,
      completionItems: new Map(),
    }
    internal.docs.set(doc.clientUri, doc)
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    internal.sendDocRequest = async (_clientUri, method, params) => {
      requests.push({ method, params })
      return {
        isIncomplete: true,
        items: [{ label: 'value', kind: 6, insertText: 'value' }],
      }
    }

    await expect(
      manager.getCompletions(doc.clientUri, { line: 2, character: 4 }, {
        triggerKind: 2,
        triggerCharacter: '.',
      }),
    ).resolves.toMatchObject({
      incomplete: true,
      items: [{ label: 'value', insertText: 'value' }],
    })
    expect(requests).toEqual([
      {
        method: 'textDocument/completion',
        params: {
          position: { line: 2, character: 4 },
          context: { triggerKind: 2, triggerCharacter: '.' },
        },
      },
    ])
    expect(doc.completionItems.size).toBe(1)
  })
})
