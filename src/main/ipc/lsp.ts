import { ipcMain, type WebContents } from 'electron'

import type { EditorFsRootRegistry } from '@main/ipc/editorFsRootRegistry.js'
import type { LspManager } from '@main/lspManager.js'
import type { LspPosition } from '@shared/types/lsp.js'

// LSP-backed code intelligence for Monaco surfaces.
//
// The renderer's CodeBlock component opens a document per visible
// code block, requests semantic tokens for coloring, and keeps the
// LSP diagnostics wired so errors inline. The Global Editor's
// MonacoFileEditor additionally uses the hover/definition/completion/
// references/symbols request channels (#513). All of that flows through
// LspManager — this file is a pure IPC adapter.

const MAX_LSP_CONTENT_BYTES = 8 * 1_048_576

export function registerLspIpc(lspManager: LspManager, roots: EditorFsRootRegistry): void {
  const documentsByOwner = new Map<number, Map<string, number>>()
  const ownerByDocument = new Map<string, number>()
  const trackedOwners = new WeakSet<WebContents>()

  const trackOwner = (sender: WebContents): void => {
    if (trackedOwners.has(sender)) return
    trackedOwners.add(sender)
    const clear = (): void => {
      const documents = documentsByOwner.get(sender.id)
      documentsByOwner.delete(sender.id)
      if (!documents) return
      for (const [clientUri, refs] of documents) {
        ownerByDocument.delete(clientUri)
        for (let i = 0; i < refs; i++) void lspManager.closeDocument(clientUri)
      }
    }
    sender.once('destroyed', clear)
    sender.on('did-start-navigation', details => {
      if (details.isMainFrame && !details.isSameDocument) clear()
    })
    sender.on('render-process-gone', clear)
  }

  const isOwned = (sender: WebContents, clientUri: string): boolean => {
    const ownerId = ownerByDocument.get(clientUri)
    // Monaco can ask a global provider for tokens/hover in the short window
    // between model creation and didOpen. Missing is a normal fail-open state;
    // a URI owned by another renderer is the actual authority violation.
    if (ownerId == null) return false
    if (ownerId !== sender.id) {
      throw new Error('LSP document is not owned by this renderer')
    }
    return true
  }

  ipcMain.handle('lsp:ensure-legend', async (evt, workspaceRoot: string, language: string) => {
    const canonicalRoot = await roots.authorize(evt.sender, workspaceRoot)
    return await lspManager.ensureSemanticLegend(canonicalRoot, language)
  })

  ipcMain.handle(
    'lsp:open-document',
    async (
      evt,
      params: {
        clientUri: string
        content: string
        language: string
        workspaceRoot: string
        filePath?: string | null
      },
    ) => {
      if (
        typeof params.clientUri !== 'string' ||
        params.clientUri.length === 0 ||
        params.clientUri.length > 8_192 ||
        typeof params.content !== 'string' ||
        Buffer.byteLength(params.content, 'utf8') > MAX_LSP_CONTENT_BYTES
      ) {
        throw new Error('invalid or oversized LSP document')
      }
      const existingOwner = ownerByDocument.get(params.clientUri)
      if (existingOwner != null && existingOwner !== evt.sender.id) {
        throw new Error('LSP document is already owned by another renderer')
      }
      const canonicalRoot = await roots.authorize(evt.sender, params.workspaceRoot)
      await lspManager.openDocument({ ...params, workspaceRoot: canonicalRoot })
      trackOwner(evt.sender)
      ownerByDocument.set(params.clientUri, evt.sender.id)
      const documents = documentsByOwner.get(evt.sender.id) ?? new Map<string, number>()
      documents.set(params.clientUri, (documents.get(params.clientUri) ?? 0) + 1)
      documentsByOwner.set(evt.sender.id, documents)
    },
  )

  ipcMain.handle('lsp:change-document', async (evt, clientUri: string, content: string) => {
    if (!isOwned(evt.sender, clientUri)) return
    if (Buffer.byteLength(content, 'utf8') > MAX_LSP_CONTENT_BYTES) {
      throw new Error('LSP document is too large')
    }
    await lspManager.changeDocument(clientUri, content)
  })

  ipcMain.handle('lsp:close-document', async (evt, clientUri: string) => {
    if (!isOwned(evt.sender, clientUri)) return
    try {
      await lspManager.closeDocument(clientUri)
    } finally {
      const documents = documentsByOwner.get(evt.sender.id)
      const refs = documents?.get(clientUri) ?? 0
      if (refs <= 1) {
        documents?.delete(clientUri)
        ownerByDocument.delete(clientUri)
      } else {
        documents?.set(clientUri, refs - 1)
      }
      if (documents?.size === 0) documentsByOwner.delete(evt.sender.id)
    }
  })

  ipcMain.handle('lsp:get-semantic-tokens', async (evt, clientUri: string) => {
    if (!isOwned(evt.sender, clientUri)) return null
    return await lspManager.getSemanticTokens(clientUri)
  })

  ipcMain.handle('lsp:get-hover', async (evt, clientUri: string, position: LspPosition) => {
    if (!isOwned(evt.sender, clientUri)) return null
    return await lspManager.getHover(clientUri, position)
  })

  ipcMain.handle('lsp:get-definition', async (evt, clientUri: string, position: LspPosition) => {
    if (!isOwned(evt.sender, clientUri)) return []
    return await lspManager.getDefinition(clientUri, position)
  })

  ipcMain.handle('lsp:get-completions', async (evt, clientUri: string, position: LspPosition) => {
    if (!isOwned(evt.sender, clientUri)) return []
    return await lspManager.getCompletions(clientUri, position)
  })

  ipcMain.handle('lsp:get-references', async (evt, clientUri: string, position: LspPosition) => {
    if (!isOwned(evt.sender, clientUri)) return []
    return await lspManager.getReferences(clientUri, position)
  })

  ipcMain.handle('lsp:get-document-symbols', async (evt, clientUri: string) => {
    if (!isOwned(evt.sender, clientUri)) return []
    return await lspManager.getDocumentSymbols(clientUri)
  })
}
