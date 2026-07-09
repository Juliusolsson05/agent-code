import { ipcMain } from 'electron'

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

export function registerLspIpc(lspManager: LspManager): void {
  ipcMain.handle(
    'lsp:ensure-legend',
    async (_evt, workspaceRoot: string, language: string) => {
      return await lspManager.ensureSemanticLegend(workspaceRoot, language)
    },
  )

  ipcMain.handle(
    'lsp:open-document',
    async (
      _evt,
      params: {
        clientUri: string
        content: string
        language: string
        workspaceRoot: string
        filePath?: string | null
      },
    ) => {
      await lspManager.openDocument(params)
    },
  )

  ipcMain.handle(
    'lsp:change-document',
    async (_evt, clientUri: string, content: string) => {
      await lspManager.changeDocument(clientUri, content)
    },
  )

  ipcMain.handle('lsp:close-document', async (_evt, clientUri: string) => {
    await lspManager.closeDocument(clientUri)
  })

  ipcMain.handle('lsp:get-semantic-tokens', async (_evt, clientUri: string) => {
    return await lspManager.getSemanticTokens(clientUri)
  })

  ipcMain.handle(
    'lsp:get-hover',
    async (_evt, clientUri: string, position: LspPosition) =>
      await lspManager.getHover(clientUri, position),
  )

  ipcMain.handle(
    'lsp:get-definition',
    async (_evt, clientUri: string, position: LspPosition) =>
      await lspManager.getDefinition(clientUri, position),
  )

  ipcMain.handle(
    'lsp:get-completions',
    async (_evt, clientUri: string, position: LspPosition) =>
      await lspManager.getCompletions(clientUri, position),
  )

  ipcMain.handle(
    'lsp:get-references',
    async (_evt, clientUri: string, position: LspPosition) =>
      await lspManager.getReferences(clientUri, position),
  )

  ipcMain.handle(
    'lsp:get-document-symbols',
    async (_evt, clientUri: string) =>
      await lspManager.getDocumentSymbols(clientUri),
  )
}
