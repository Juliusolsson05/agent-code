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
   * This set is what makes the difference sayable: a URI in it was supposed
   * to have a document, so a change that finds none is the loss. A URI not in
   * it never had one, so a change is a no-op and resolves.
   */
  const lspBackedDocuments = new Set<string>()

  /**
   * One number per renderer, bumped every time clear() drops its documents
   * (#1266 review A2/B2).
   *
   * WHY an epoch and not the WebContents id alone: navigation keeps the id.
   * A reopen issued by the old page can pause in authorization while the
   * page navigates (clear() runs) and the NEW page opens the same client URI.
   * Comparing ids alone accepted that new page's ownership and reference
   * count, then re-sent the old page's text under the old page's
   * authorization. A reopen captures the epoch when it arrives and is void
   * the moment it moves.
   */
  const ownerEpochs = new Map<number, number>()

  /**
   * Opens whose IPC reference is already counted (addOwnedDocument runs
   * before the queue, see lsp:open-document) but whose queued manager open
   * has not started yet (#1266 review B1).
   *
   * A reopen restores the manager to the owner's IPC count. Without this, an
   * open queued BEHIND the reopen was counted twice: once by the reopen,
   * which read its IPC ref, and once more by its own manager open, leaving
   * the manager one reference above IPC and a server document that no close
   * ever releases. Keyed by client URI because a URI has one owner.
   */
  const pendingOpens = new Map<string, number>()

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
      ownerEpochs.set(sender.id, (ownerEpochs.get(sender.id) ?? 0) + 1)
      const documents = documentsByOwner.get(sender.id)
      documentsByOwner.delete(sender.id)
      if (!documents) return
      for (const [clientUri, refs] of documents) {
        ownerByDocument.delete(clientUri)
        lspBackedDocuments.delete(clientUri)
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
      pendingOpens.set(params.clientUri, (pendingOpens.get(params.clientUri) ?? 0) + 1)
      try {
        await serializeDocument(params.clientUri, async () => {
          // From here on this open is no longer "pending": whatever the
          // manager holds now, it adds its own reference below. See
          // pendingOpens.
          const pending = (pendingOpens.get(params.clientUri) ?? 1) - 1
          if (pending > 0) pendingOpens.set(params.clientUri, pending)
          else pendingOpens.delete(params.clientUri)
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
            if (opened) lspBackedDocuments.add(params.clientUri)
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
        if (!ownerByDocument.has(params.clientUri)) lspBackedDocuments.delete(params.clientUri)
        throw err
      }
    },
  )

  // #1208: an editor that stays open after its server was lost (a crash, or
  // retirement for ignoring cancelled requests, #924) asks for its document
  // back. WHY the renderer drives this, with its own current authorization,
  // rather than main re-opening from what it cached at the first open: that
  // design was reviewed and withdrawn. A cached capability outlived its owner,
  // skipped the physical checks (a directory swapped for a symlink out of the
  // root re-opened fine), and restored one reference of two. Here:
  //   - only the renderer that owns the URI may ask;
  //   - authorization is re-run NOW through authorizeContext, physical
  //     target and regular-file checks included; nothing cached is reused;
  //   - it runs in the URI's IPC queue and re-checks ownership, by owner
  //     EPOCH, after authorization and again after the manager open; an owner
  //     cleared or navigated at any point gets nothing (#1266 review A2/B2);
  //   - it restores the manager to the owner's IPC reference count for the
  //     URI, minus opens still queued behind it, so two mounts get two
  //     references back and a third mount arriving meanwhile is counted
  //     once, by its own open (#1266 review B1);
  //   - it is a no-op while the manager still has the document.
  ipcMain.handle(
    'lsp:reopen-document',
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
    ): Promise<boolean> => {
      if (
        typeof params.clientUri !== 'string' ||
        params.clientUri.length === 0 ||
        params.clientUri.length > 8_192 ||
        typeof params.content !== 'string' ||
        Buffer.byteLength(params.content, 'utf8') > MAX_LSP_CONTENT_BYTES
      ) {
        throw new Error('invalid or oversized LSP document')
      }
      if (!isOwned(evt.sender, params.clientUri)) return false
      // Captured when the request ARRIVES: it speaks for the page that sent
      // it, and any later clear() means that page is gone.
      const epoch = ownerEpochs.get(evt.sender.id) ?? 0
      return await serializeDocument(params.clientUri, async () => {
        const stillOwned = (): boolean =>
          ownerByDocument.get(params.clientUri) === evt.sender.id &&
          !evt.sender.isDestroyed() &&
          (ownerEpochs.get(evt.sender.id) ?? 0) === epoch
        if (!stillOwned()) return false
        if (lspManager.hasDocument(params.clientUri)) return true
        const context = await authorizeContext(evt.sender, params)
        // The page may have navigated during authorization, and its
        // successor may even own this URI again under the same WebContents
        // id; the epoch tells them apart (#1266 review A2).
        if (!stillOwned()) return false
        const refs =
          (documentsByOwner.get(evt.sender.id)?.get(params.clientUri) ?? 0) -
          (pendingOpens.get(params.clientUri) ?? 0)
        // Every reference the owner holds belongs to an open still queued
        // behind this one; that open restores the document itself. Marking
        // the URI backed here would be a guess about its outcome.
        if (refs <= 0) return false
        // Transactional against the manager's OWN count, not the number of
        // opens that fulfilled (steering q23): an open can count a shared-alias
        // reference and then throw on its didChange. The manager had no
        // document before this (the no-op guard above), so every reference it
        // holds after a failure belongs to this attempt and is closed.
        let opened = 0
        let failure: unknown = null
        try {
          for (; opened < refs; opened++) {
            const ok = await lspManager.openDocument({
              clientUri: params.clientUri,
              content: params.content,
              language: params.language,
              workspaceRoot: context.workspaceRoot,
              filePath: context.filePath,
            })
            if (!ok) break
          }
        } catch (err) {
          failure = err
        }
        // The owner can also go away DURING the manager open (a cold server
        // spawn is seconds). clear() then queued closes behind this entry
        // and dropped the backed marker; adding the marker back, or keeping
        // references for a page that is gone, left the next owner of the URI
        // with a stale "backed" flag (#1266 review B2). Undo it here, inside
        // the queue entry, so those queued closes find nothing.
        const ownerLeft = !stillOwned()
        if (failure !== null || opened < refs || ownerLeft) {
          for (let leaked = lspManager.documentRefs(params.clientUri); leaked > 0; leaked--) {
            await lspManager.closeDocument(params.clientUri).catch(() => undefined)
          }
          if (failure !== null && !ownerLeft) throw failure
          return false
        }
        lspBackedDocuments.add(params.clientUri)
        return true
      })
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
    const applied = await serializeDocument(clientUri, () =>
      lspManager.changeDocument(clientUri, content),
    )
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
        if (!ownerByDocument.has(clientUri)) lspBackedDocuments.delete(clientUri)
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
