import { describe, expect, it, vi } from 'vitest'

import { LspManager } from './lspManager.js'

type TestDocument = {
  clientUri: string
  serverKey: string
  serverUri: string
  serverDocumentKey: string
  version: number
  language: string
  refs: number
  content: string
  completionItems: Map<number, object>
}

type TestServerDocument = {
  key: string
  serverKey: string
  serverUri: string
  language: string
  version: number
  refs: number
  content: string
  activeClientUri: string
}

type LspManagerInternals = {
  docs: Map<string, TestDocument>
  serverDocuments: Map<string, TestServerDocument>
  servers: Map<string, object>
  getOrCreateServer: () => Promise<object>
  sendNotificationIfOpen: (server: object, method: string, params: unknown) => Promise<void>
  sendDocRequest: (
    clientUri: string,
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>
  handlePublishDiagnostics: (
    serverKey: string,
    params: {
      uri: string
      version?: number
      diagnostics: Array<{
        message: string
        severity: number
        range: {
          start: { line: number; character: number }
          end: { line: number; character: number }
        }
      }>
    },
  ) => void
}

describe('LspManager document ownership', () => {
  it('changes shared documents without consuming refs and closes only the last owner', async () => {
    const manager = new LspManager()
    const internal = manager as unknown as LspManagerInternals
    const server = {}
    const notifications: string[] = []
    internal.servers.set('server', server)
    const sharedKey = 'server\0file:///repo/file.ts'
    internal.serverDocuments.set(sharedKey, {
      key: sharedKey,
      serverKey: 'server',
      serverUri: 'file:///repo/file.ts',
      language: 'typescript',
      version: 1,
      refs: 2,
      content: 'old text',
      activeClientUri: 'file:///repo/file.ts',
    })
    internal.docs.set('file:///repo/file.ts', {
      clientUri: 'file:///repo/file.ts',
      serverKey: 'server',
      serverUri: 'file:///repo/file.ts',
      serverDocumentKey: sharedKey,
      version: 1,
      language: 'typescript',
      refs: 2,
      content: 'old text',
      completionItems: new Map(),
    })
    internal.sendNotificationIfOpen = async (_server, method) => {
      notifications.push(method)
    }

    await manager.changeDocument('file:///repo/file.ts', 'new text')
    expect(internal.docs.get('file:///repo/file.ts')).toMatchObject({
      refs: 2,
      version: 2,
    })
    expect(notifications).toEqual(['textDocument/didChange'])

    await manager.closeDocument('file:///repo/file.ts')
    expect(internal.docs.get('file:///repo/file.ts')?.refs).toBe(1)
    expect(notifications).toEqual(['textDocument/didChange'])

    await manager.closeDocument('file:///repo/file.ts')
    expect(internal.docs.has('file:///repo/file.ts')).toBe(false)
    expect(notifications).toEqual(['textDocument/didChange', 'textDocument/didClose'])
  })

  it('shares one server URI lifetime across isolated client URIs and restores the survivor', async () => {
    const manager = new LspManager()
    const internal = manager as unknown as LspManagerInternals
    const server = {
      key: 'server',
      initialized: Promise.resolve({}),
      closed: false,
    }
    internal.servers.set('server', server)
    internal.getOrCreateServer = async () => server
    const notifications: Array<{ method: string; params: unknown }> = []
    internal.sendNotificationIfOpen = async (_server, method, params) => {
      notifications.push({ method, params })
    }
    const common = {
      language: 'typescript',
      workspaceRoot: '/repo',
      filePath: 'shared.ts',
    }

    await manager.openDocument({
      ...common,
      clientUri: 'cc-file://global/shared.ts?buffer=1',
      content: 'global draft',
    })
    await manager.openDocument({
      ...common,
      clientUri: 'cc-file://ai/shared.ts?buffer=2',
      content: 'ai draft',
    })

    expect(notifications.map(item => item.method)).toEqual([
      'textDocument/didOpen',
      'textDocument/didChange',
    ])
    expect([...internal.serverDocuments.values()][0]).toMatchObject({
      refs: 2,
      version: 2,
      content: 'ai draft',
    })

    await manager.closeDocument('cc-file://ai/shared.ts?buffer=2')
    expect(notifications.map(item => item.method)).toEqual([
      'textDocument/didOpen',
      'textDocument/didChange',
      'textDocument/didChange',
    ])
    expect([...internal.serverDocuments.values()][0]).toMatchObject({
      refs: 1,
      version: 3,
      content: 'global draft',
    })

    await manager.closeDocument('cc-file://global/shared.ts?buffer=1')
    expect(notifications.map(item => item.method).at(-1)).toBe('textDocument/didClose')
    expect(internal.serverDocuments.size).toBe(0)
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

  it('discards a delayed document response after newer change intent', async () => {
    const manager = new LspManager()
    const internal = manager as unknown as LspManagerInternals
    const clientUri = 'cc-file://global/shared.ts?buffer=1'
    const sharedKey = 'server\0file:///repo/shared.ts'
    let releaseRequest!: (value: unknown) => void
    let markRequestStarted!: () => void
    const requestStarted = new Promise<void>(resolve => {
      markRequestStarted = resolve
    })
    const server = {
      key: 'server',
      initialized: Promise.resolve({}),
      closed: false,
      connection: {
        sendRequest: () => {
          markRequestStarted()
          return new Promise(resolve => {
            releaseRequest = resolve
          })
        },
      },
    }
    internal.servers.set('server', server)
    internal.serverDocuments.set(sharedKey, {
      key: sharedKey,
      serverKey: 'server',
      serverUri: 'file:///repo/shared.ts',
      language: 'typescript',
      version: 1,
      refs: 1,
      content: 'old text',
      activeClientUri: clientUri,
    })
    internal.docs.set(clientUri, {
      clientUri,
      serverKey: 'server',
      serverUri: 'file:///repo/shared.ts',
      serverDocumentKey: sharedKey,
      version: 1,
      language: 'typescript',
      refs: 1,
      content: 'old text',
      completionItems: new Map(),
    })
    const notifications: string[] = []
    internal.sendNotificationIfOpen = async (_server, method) => {
      notifications.push(method)
    }

    const symbols = manager.getDocumentSymbols(clientUri)
    await requestStarted
    const changed = manager.changeDocument(clientUri, 'new text')
    releaseRequest([
      {
        name: 'stale symbol',
        kind: 1,
        location: {
          uri: 'file:///repo/shared.ts',
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
        },
      },
    ])

    await expect(symbols).resolves.toEqual([])
    await changed
    expect(internal.docs.get(clientUri)?.content).toBe('new text')
    expect(notifications).toEqual(['textDocument/didChange'])
  })

  it('releases document changes when a language server request never answers', async () => {
    vi.useFakeTimers()
    try {
      const manager = new LspManager()
      const internal = manager as unknown as LspManagerInternals
      const clientUri = 'cc-file://global/hung.ts?buffer=1'
      const sharedKey = 'server\0file:///repo/hung.ts'
      let markRequestStarted!: () => void
      const requestStarted = new Promise<void>(resolve => {
        markRequestStarted = resolve
      })
      const server = {
        key: 'server',
        initialized: Promise.resolve({}),
        closed: false,
        connection: {
          sendRequest: () => {
            markRequestStarted()
            return new Promise(() => undefined)
          },
        },
      }
      internal.servers.set('server', server)
      internal.serverDocuments.set(sharedKey, {
        key: sharedKey,
        serverKey: 'server',
        serverUri: 'file:///repo/hung.ts',
        language: 'typescript',
        version: 1,
        refs: 1,
        content: 'old text',
        activeClientUri: clientUri,
      })
      internal.docs.set(clientUri, {
        clientUri,
        serverKey: 'server',
        serverUri: 'file:///repo/hung.ts',
        serverDocumentKey: sharedKey,
        version: 1,
        language: 'typescript',
        refs: 1,
        content: 'old text',
        completionItems: new Map(),
      })
      internal.sendNotificationIfOpen = async () => undefined

      const symbols = manager.getDocumentSymbols(clientUri)
      await requestStarted
      const changed = manager.changeDocument(clientUri, 'new text')
      await vi.advanceTimersByTimeAsync(15_000)

      await expect(symbols).resolves.toEqual([])
      await changed
      expect(internal.docs.get(clientUri)?.content).toBe('new text')
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops diagnostics that arrive after a newer shared document version', () => {
    const manager = new LspManager()
    const internal = manager as unknown as LspManagerInternals
    const serverUri = 'file:///repo/shared.ts'
    const sharedKey = `server\0${serverUri}`
    internal.serverDocuments.set(sharedKey, {
      key: sharedKey,
      serverKey: 'server',
      serverUri,
      language: 'typescript',
      version: 4,
      refs: 2,
      content: 'draft B',
      activeClientUri: 'client-b',
    })
    for (const [clientUri, content] of [
      ['client-a', 'draft A'],
      ['client-b', 'draft B'],
    ]) {
      internal.docs.set(clientUri, {
        clientUri,
        serverKey: 'server',
        serverUri,
        serverDocumentKey: sharedKey,
        version: 4,
        language: 'typescript',
        refs: 1,
        content,
        completionItems: new Map(),
      })
    }
    const events: unknown[] = []
    manager.on('diagnostics', event => events.push(event))
    const diagnostic = {
      message: 'stale marker',
      severity: 1,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
    }

    internal.handlePublishDiagnostics('server', {
      uri: serverUri,
      version: 3,
      diagnostics: [diagnostic],
    })
    expect(events).toEqual([])

    internal.handlePublishDiagnostics('server', {
      uri: serverUri,
      version: 4,
      diagnostics: [{ ...diagnostic, message: 'current marker' }],
    })
    expect(events).toEqual([
      { clientUri: 'client-a', diagnostics: [] },
      {
        clientUri: 'client-b',
        diagnostics: [expect.objectContaining({ message: 'current marker' })],
      },
    ])
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
      serverDocumentKey: 'server\0file:///repo/file.ts',
      version: 1,
      language: 'typescript',
      refs: 1,
      content: 'const value = 1',
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

  it('falls back to the original completion item when resolve wedges', async () => {
    vi.useFakeTimers()
    try {
      const manager = new LspManager()
      const internal = manager as unknown as LspManagerInternals
      const rawItem = { label: 'value', kind: 6, insertText: 'value' }
      internal.servers.set('server', {
        closed: false,
        initialized: Promise.resolve({
          capabilities: { completionProvider: { resolveProvider: true } },
        }),
        connection: {
          sendRequest: () => new Promise(() => {}),
        },
      })
      internal.docs.set('file:///repo/file.ts', {
        clientUri: 'file:///repo/file.ts',
        serverKey: 'server',
        serverUri: 'file:///repo/file.ts',
        serverDocumentKey: 'server\0file:///repo/file.ts',
        version: 1,
        language: 'typescript',
        refs: 1,
        content: 'const value = 1',
        completionItems: new Map([[1, rawItem]]),
      })

      const pending = manager.resolveCompletion('file:///repo/file.ts', 1)
      await vi.advanceTimersByTimeAsync(15_000)

      await expect(pending).resolves.toMatchObject({
        label: 'value',
        insertText: 'value',
        resolveId: 1,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves completion trigger context and incomplete-list semantics', async () => {
    const manager = new LspManager()
    const internal = manager as unknown as LspManagerInternals
    const doc: TestDocument = {
      clientUri: 'file:///repo/file.ts',
      serverKey: 'server',
      serverUri: 'file:///repo/file.ts',
      serverDocumentKey: 'server\0file:///repo/file.ts',
      version: 1,
      language: 'typescript',
      refs: 1,
      content: 'const value = 1',
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
      manager.getCompletions(
        doc.clientUri,
        { line: 2, character: 4 },
        {
          triggerKind: 2,
          triggerCharacter: '.',
        },
      ),
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

  it('bounds document-symbol count and hierarchy depth before crossing IPC', async () => {
    const manager = new LspManager()
    const internal = manager as unknown as LspManagerInternals
    const range = {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    }
    internal.sendDocRequest = async () =>
      Array.from({ length: 2_100 }, (_, index) => ({
        name: `symbol-${index}`,
        kind: 1,
        location: { uri: 'file:///repo/file.ts', range },
      }))

    await expect(manager.getDocumentSymbols('file:///repo/file.ts')).resolves.toHaveLength(2_000)

    let nested: Record<string, unknown> = {
      name: 'leaf',
      kind: 1,
      range,
      selectionRange: range,
      children: [],
    }
    for (let depth = 0; depth < 40; depth += 1) {
      nested = {
        name: `parent-${depth}`,
        kind: 1,
        range,
        selectionRange: range,
        children: [nested],
      }
    }
    internal.sendDocRequest = async () => [nested]
    const [root] = await manager.getDocumentSymbols('file:///repo/file.ts')
    let observedDepth = 0
    let current = root
    while (current) {
      observedDepth += 1
      current = current.children[0]
    }
    expect(observedDepth).toBe(32)
  })

  it('preserves declaration and selection ranges for nested document symbols', async () => {
    const manager = new LspManager()
    const internal = manager as unknown as LspManagerInternals
    internal.sendDocRequest = async () => [
      {
        name: 'Parent',
        kind: 5,
        range: {
          start: { line: 1, character: 0 },
          end: { line: 12, character: 1 },
        },
        selectionRange: {
          start: { line: 1, character: 6 },
          end: { line: 1, character: 12 },
        },
        children: [
          {
            name: 'child',
            kind: 6,
            range: {
              start: { line: 4, character: 2 },
              end: { line: 8, character: 3 },
            },
            selectionRange: {
              start: { line: 4, character: 10 },
              end: { line: 4, character: 15 },
            },
            children: [],
          },
        ],
      },
    ]

    await expect(manager.getDocumentSymbols('file:///repo/file.ts')).resolves.toEqual([
      expect.objectContaining({
        startLine: 1,
        startCharacter: 0,
        endLine: 12,
        endCharacter: 1,
        selectionStartLine: 1,
        selectionStartCharacter: 6,
        selectionEndLine: 1,
        selectionEndCharacter: 12,
        children: [
          expect.objectContaining({
            startLine: 4,
            endLine: 8,
            selectionStartLine: 4,
            selectionStartCharacter: 10,
            selectionEndCharacter: 15,
          }),
        ],
      }),
    ])
  })
})
