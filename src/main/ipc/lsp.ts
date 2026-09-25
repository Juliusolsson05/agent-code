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
/**
 * Minimum time between two automatic re-opens of one backed document whose
 * server went away (see `lsp:change-document`). Long enough that a server
 * which dies on startup restarts a couple of times a minute at most instead of
 * on every debounced keystroke; short enough that a one-off crash or
 * retirement heals within the user's next few edits.
 */
const LSP_REOPEN_COOLDOWN_MS = 30_000

/** The authorized open a backed document was created with, reused to re-open it. */
type BackedDocumentOpen = { language: string; workspaceRoot: string; filePath: string | null }

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
  /**
   * Client URIs that really do have a server document behind them (#1108
   * review, 3).
   *
   * `lsp:change-document` rejects when the manager has no document, so the
   * renderer is told rather than silently losing a keystroke (#922). But
   * "no document" is also the ORDINARY state for a language whose server is
   * not installed, an unsupported language, or a spawn that failed — all of
   * which the registry documents as fail-open: "the editor works without LSP
   * for that language". Rejecting there turned a documented no-op into a
   * rejection on every debounced change, and the renderer's coalescing gate
   * never advanced its synced version, so every later hover and completion
   * re-issued a doomed round trip instead of one no-op per version.
   *
   * This map is what makes the difference sayable: a URI in it was supposed
   * to have a document, so a change that finds none is the loss. A URI not in
   * it never had one, so a change is a no-op and resolves.
   *
   * The value is the AUTHORIZED open (resolved root and file path, not the
   * renderer's claim), kept so a backed document whose server went away can
   * be re-opened from its next edit — see `lsp:change-document`.
   */
  const lspBackedDocuments = new Map<string, BackedDocumentOpen>()
  /** When each backed document was last re-opened; see LSP_REOPEN_COOLDOWN_MS. */
  const lastReopenAt = new Map<string, number>()
  const forgetBackedDocument = (clientUri: string): void => {
    lspBackedDocuments.delete(clientUri)
    lastReopenAt.delete(clientUri)
  }

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
        forgetBackedDocument(clientUri)
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
            const opened = await lspManager.openDocument({
              clientUri: params.clientUri,
              content: params.content,
              language: params.language,
              workspaceRoot: context.workspaceRoot,
              filePath: context.filePath,
            })
            if (opened) {
              lspBackedDocuments.set(params.clientUri, {
                language: params.language,
                workspaceRoot: context.workspaceRoot,
                filePath: context.filePath,
              })
            }
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
        if (!ownerByDocument.has(params.clientUri)) forgetBackedDocument(params.clientUri)
        throw err
      }
    },
  )

  ipcMain.handle('lsp:change-document', async (evt, clientUri: string, content: string) => {
    if (!isOwned(evt.sender, clientUri)) return
    if (Buffer.byteLength(content, 'utf8') > MAX_LSP_CONTENT_BYTES) {
      throw new Error('LSP document is too large')
    }
    // Through the SAME queue the open holds, not around it (#922).
    //
    // Ownership is registered synchronously by `lsp:open-document`, before its
    // queued entry awaits authorization and a server spawn. A change arriving
    // in that window therefore passed `isOwned` while LspManager still had no
    // document for the URI: it hit `if (!doc) return`, resolved successfully,
    // and the open then installed the ORIGINAL text. The renderer was told its
    // edit landed and the server never saw it.
    //
    // Queueing makes the ordering the obvious one — open with the text the
    // open carried, then didChange to what the user has since typed — and the
    // boolean makes the failing case loud instead of silent. The cost is that
    // this IPC call now resolves only once the open ahead of it finishes,
    // which during a cold server spawn is seconds; that is the right trade
    // against acknowledging a write that never happened.
    const applied = await serializeDocument(clientUri, async () => {
      if (await lspManager.changeDocument(clientUri, content)) return true
      // A BACKED document with no manager record lost its server: a crash, or
      // a deliberate retirement of a wedged one (#924). Before this, the
      // editor stayed without hover, completion and diagnostics until it was
      // remounted, and the rejection below reached a renderer that swallows
      // it (`editorLanguageFeatures` returns false), so nothing ever told the
      // user or recovered. Re-open with the text the user just typed instead;
      // `openDocument` spawns a fresh server exactly as a first open does.
      //
      // WHY a cooldown: a server that dies on startup would otherwise be
      // re-spawned on every debounced keystroke. One attempt per window per
      // document bounds that to a restart rate, and a failed attempt still
      // rejects below, which is the pre-existing "loud" outcome.
      const open = lspBackedDocuments.get(clientUri)
      if (!open) return false
      const now = Date.now()
      const last = lastReopenAt.get(clientUri)
      if (last !== undefined && now - last < LSP_REOPEN_COOLDOWN_MS) return false
      lastReopenAt.set(clientUri, now)
      return await lspManager.openDocument({ clientUri, content, ...open })
    })
    // Only a URI that was actually backed by a server document can LOSE one.
    // For every other URI this is the documented fail-open no-op — see
    // `lspBackedDocuments`.
    if (!applied && lspBackedDocuments.has(clientUri)) {
      throw new Error('LSP document is not open')
    }
  })

  ipcMain.handle('lsp:close-document', async (evt, clientUri: string) => {
    if (!isOwned(evt.sender, clientUri)) return
    await serializeDocument(clientUri, async () => {
      try {
        await lspManager.closeDocument(clientUri)
      } finally {
        removeOwnedDocument(evt.sender.id, clientUri)
        if (!ownerByDocument.has(clientUri)) forgetBackedDocument(clientUri)
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
