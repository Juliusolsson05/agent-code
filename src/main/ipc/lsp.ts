import { ipcMain, type WebContents } from 'electron'
import { lstat } from 'fs/promises'
import { relative } from 'path'

import type { AiWorkspaceRegistry } from '@main/aiWorkspace/AiWorkspaceRegistry.js'
import { resolveInsideRoot, validateExistingTarget } from '@main/ipc/editorFs.js'
import type { EditorFsRootRegistry } from '@main/ipc/editorFsRootRegistry.js'
import type { LspManager } from '@main/lspManager.js'
import type {
  LspCompletionContext,
  LspDocumentAuthorization,
  LspPosition,
} from '@shared/types/lsp.js'

// LSP-backed code intelligence for Monaco surfaces.
//
// The renderer's CodeBlock component opens a document per visible
// code block, requests semantic tokens for coloring, and keeps the
// LSP diagnostics wired so errors inline. The Global Editor's
// MonacoFileEditor additionally uses the hover/definition/completion/
// references/symbols request channels (#513). All of that flows through
// LspManager — this file is a pure IPC adapter.

const MAX_LSP_CONTENT_BYTES = 1_048_576
const MAX_LSP_DOCUMENTS_PER_RENDERER = 256

function validPosition(position: LspPosition): boolean {
  return (
    position != null &&
    Number.isSafeInteger(position.line) &&
    position.line >= 0 &&
    Number.isSafeInteger(position.character) &&
    position.character >= 0
  )
}

function validCompletionContext(context: LspCompletionContext): boolean {
  return (
    context != null &&
    (context.triggerKind === 1 || context.triggerKind === 2 || context.triggerKind === 3) &&
    (context.triggerCharacter == null ||
      (typeof context.triggerCharacter === 'string' && context.triggerCharacter.length <= 8))
  )
}

export function registerLspIpc(
  lspManager: LspManager,
  roots: EditorFsRootRegistry,
  aiWorkspaces: AiWorkspaceRegistry,
): void {
  const documentsByOwner = new Map<number, Map<string, number>>()
  const ownerByDocument = new Map<string, number>()
  const trackedOwners = new WeakSet<WebContents>()
  // Authorization can touch disk and server startup can be slow. Serialize
  // the whole IPC lifecycle (including authorization), not only LspManager's
  // didOpen/didClose calls, so a navigation cleanup that arrives during that
  // await is guaranteed to close after the eventual open instead of racing
  // ahead as a no-op and leaving a document behind.
  const documentQueues = new Map<string, Promise<void>>()

  const serializeDocument = async <T>(clientUri: string, task: () => Promise<T>): Promise<T> => {
    const previous = documentQueues.get(clientUri) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(task)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    documentQueues.set(clientUri, tail)
    try {
      return await result
    } finally {
      if (documentQueues.get(clientUri) === tail) documentQueues.delete(clientUri)
    }
  }

  const trackOwner = (sender: WebContents): void => {
    if (trackedOwners.has(sender)) return
    trackedOwners.add(sender)
    const clear = (): void => {
      const documents = documentsByOwner.get(sender.id)
      documentsByOwner.delete(sender.id)
      if (!documents) return
      for (const [clientUri, refs] of documents) {
        ownerByDocument.delete(clientUri)
        for (let i = 0; i < refs; i++) {
          void serializeDocument(clientUri, () => lspManager.closeDocument(clientUri))
        }
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

  const addOwnedDocument = (sender: WebContents, clientUri: string): void => {
    trackOwner(sender)
    const documents = documentsByOwner.get(sender.id) ?? new Map<string, number>()
    // Every open document retains server-side text and diagnostics state. A
    // compromised or runaway renderer must not turn valid session-root access
    // into an unbounded main-process/server allocation loop.
    if (!documents.has(clientUri) && documents.size >= MAX_LSP_DOCUMENTS_PER_RENDERER) {
      throw new Error('too many open LSP documents')
    }
    ownerByDocument.set(clientUri, sender.id)
    documents.set(clientUri, (documents.get(clientUri) ?? 0) + 1)
    documentsByOwner.set(sender.id, documents)
  }

  const removeOwnedDocument = (senderId: number, clientUri: string): void => {
    const documents = documentsByOwner.get(senderId)
    const refs = documents?.get(clientUri) ?? 0
    if (refs <= 1) {
      documents?.delete(clientUri)
      if (ownerByDocument.get(clientUri) === senderId) ownerByDocument.delete(clientUri)
    } else {
      documents?.set(clientUri, refs - 1)
    }
    if (documents?.size === 0) documentsByOwner.delete(senderId)
  }

  const authorizeContext = async (
    sender: WebContents,
    params: {
      workspaceRoot: string
      filePath?: string | null
      authorization: LspDocumentAuthorization
    },
  ): Promise<{ workspaceRoot: string; filePath: string | null }> => {
    if (params.authorization?.kind === 'ai-workspace') {
      if (!params.authorization.workspaceId || !params.authorization.entryId) {
        throw new Error('AI Workspace LSP authorization is incomplete')
      }
      return await aiWorkspaces.authorizeLspEntry(
        params.authorization.workspaceId,
        params.authorization.entryId,
      )
    }
    if (params.authorization?.kind !== 'editor-root') {
      throw new Error('LSP document authorization is required')
    }
    const workspaceRoot = await roots.authorize(sender, params.workspaceRoot)
    if (!params.filePath) return { workspaceRoot, filePath: null }
    const requested = resolveInsideRoot(workspaceRoot, params.filePath)
    const physical = await validateExistingTarget(workspaceRoot, requested)
    if (!(await lstat(physical)).isFile()) throw new Error('LSP document is not a file')
    return {
      workspaceRoot,
      filePath: relative(workspaceRoot, physical),
    }
  }

  ipcMain.handle(
    'lsp:ensure-legend',
    async (
      evt,
      params: {
        workspaceRoot: string
        language: string
        authorization: LspDocumentAuthorization
      },
    ) => {
      const context = await authorizeContext(evt.sender, {
        workspaceRoot: params.workspaceRoot,
        filePath: null,
        authorization: params.authorization,
      })
      return await lspManager.ensureSemanticLegend(context.workspaceRoot, params.language)
    },
  )

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
        authorization: LspDocumentAuthorization
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
      // Establish renderer ownership before the first await. A navigation or
      // close can race root authorization/server startup; registering late let
      // clear() miss the in-flight document and leak it after the renderer was
      // gone. LspManager's per-URI queue orders the eventual open/close pair.
      addOwnedDocument(evt.sender, params.clientUri)
      try {
        await serializeDocument(params.clientUri, async () => {
          let managerOpenStarted = false
          try {
            const context = await authorizeContext(evt.sender, params)
            managerOpenStarted = true
            await lspManager.openDocument({
              clientUri: params.clientUri,
              content: params.content,
              language: params.language,
              workspaceRoot: context.workspaceRoot,
              filePath: context.filePath,
            })
          } catch (err) {
            // Keep rollback inside the same IPC queue entry. A renderer
            // navigation may already have queued its own cleanup behind this
            // open; letting rollback escape the entry would race those closes
            // and could consume a ref belonging to an older mount.
            if (managerOpenStarted) {
              await lspManager.closeDocument(params.clientUri).catch(() => undefined)
            }
            throw err
          }
        })
      } catch (err) {
        removeOwnedDocument(evt.sender.id, params.clientUri)
        throw err
      }
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
    await serializeDocument(clientUri, async () => {
      try {
        await lspManager.closeDocument(clientUri)
      } finally {
        removeOwnedDocument(evt.sender.id, clientUri)
      }
    })
  })

  ipcMain.handle('lsp:get-semantic-tokens', async (evt, clientUri: string) => {
    if (!isOwned(evt.sender, clientUri)) return null
    return await lspManager.getSemanticTokens(clientUri)
  })

  ipcMain.handle('lsp:get-hover', async (evt, clientUri: string, position: LspPosition) => {
    if (!isOwned(evt.sender, clientUri)) return null
    if (!validPosition(position)) return null
    return await lspManager.getHover(clientUri, position)
  })

  ipcMain.handle('lsp:get-definition', async (evt, clientUri: string, position: LspPosition) => {
    if (!isOwned(evt.sender, clientUri)) return []
    if (!validPosition(position)) return []
    return await lspManager.getDefinition(clientUri, position)
  })

  ipcMain.handle(
    'lsp:get-completions',
    async (evt, clientUri: string, position: LspPosition, context: LspCompletionContext) => {
      if (!isOwned(evt.sender, clientUri)) return { items: [], incomplete: false }
      if (!validPosition(position) || !validCompletionContext(context)) {
        return { items: [], incomplete: false }
      }
      return await lspManager.getCompletions(clientUri, position, context)
    },
  )

  ipcMain.handle('lsp:resolve-completion', async (evt, clientUri: string, resolveId: number) => {
    if (!isOwned(evt.sender, clientUri)) return null
    if (!Number.isSafeInteger(resolveId) || resolveId <= 0) return null
    return await lspManager.resolveCompletion(clientUri, resolveId)
  })

  ipcMain.handle('lsp:get-references', async (evt, clientUri: string, position: LspPosition) => {
    if (!isOwned(evt.sender, clientUri)) return []
    if (!validPosition(position)) return []
    return await lspManager.getReferences(clientUri, position)
  })

  ipcMain.handle('lsp:get-document-symbols', async (evt, clientUri: string) => {
    if (!isOwned(evt.sender, clientUri)) return []
    return await lspManager.getDocumentSymbols(clientUri)
  })
}
