import { EventEmitter } from 'events'
import { spawn } from 'child_process'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { isAbsolute, relative, resolve } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

import {
  CancellationTokenSource,
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node.js'
import type { MessageConnection } from 'vscode-jsonrpc/node.js'
import { DiagnosticSeverity } from 'vscode-languageserver-protocol'
import type {
  CompletionItem,
  CompletionList,
  DocumentSymbol,
  Hover,
  InitializeParams,
  InitializeResult,
  Location,
  LocationLink,
  PublishDiagnosticsParams,
  Range,
  SemanticTokens,
  SemanticTokensLegend,
  SymbolInformation,
} from 'vscode-languageserver-protocol'

import { languageFileExtension, supportsLsp } from '@shared/code/language.js'
import { lspServerForLanguage, type LspServerSpec } from '@main/lsp/serverRegistry.js'
// Diagnostics event shape is the shared renderer↔main contract. Re-export so
// existing importers of `LspDiagnostic`/`LspDiagnosticsEvent` from
// `@main/lspManager` keep working, but the source of truth is shared.
import type {
  LspCompletionItem,
  LspCompletionContext,
  LspCompletionResult,
  LspDiagnostic,
  LspDiagnosticsEvent,
  LspDocumentSymbol,
  LspHoverResult,
  LspLocation,
  LspPosition,
} from '@shared/types/lsp.js'
export type { LspDiagnostic, LspDiagnosticsEvent } from '@shared/types/lsp.js'

type OpenDocumentParams = {
  clientUri: string
  content: string
  language: string
  workspaceRoot: string
  filePath?: string | null
}

type OpenDocumentRecord = {
  clientUri: string
  serverKey: string
  serverUri: string
  serverDocumentKey: string
  version: number
  language: string
  refs: number
  content: string
  completionItems: Map<number, CompletionItem>
}

type ServerDocumentRecord = {
  key: string
  serverKey: string
  serverUri: string
  language: string
  version: number
  refs: number
  content: string
  activeClientUri: string
}

type ServerRecord = {
  key: string
  specId: string
  workspaceRoot: string
  process: ChildProcessWithoutNullStreams
  connection: MessageConnection
  initialized: Promise<InitializeResult>
  legendPromise: Promise<SemanticTokensLegend | null>
  closed: boolean
}

const LSP_DOCUMENT_REQUEST_TIMEOUT_MS = 15_000
const LSP_INITIALIZE_TIMEOUT_MS = 30_000
const LSP_REQUEST_TIMED_OUT = Symbol('lsp-request-timed-out')

function toSeverity(severity?: DiagnosticSeverity): LspDiagnostic['severity'] {
  if (severity === DiagnosticSeverity.Error) return 'error'
  if (severity === DiagnosticSeverity.Warning) return 'warning'
  if (severity === DiagnosticSeverity.Information) return 'info'
  return 'hint'
}

function hashText(input: string): string {
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0
  }
  return Math.abs(hash).toString(16)
}

function makeVirtualServerUri(workspaceRoot: string, clientUri: string, language: string): string {
  const ext = languageFileExtension(language)
  const filePath = resolve(
    workspaceRoot,
    '.agent-code-lsp',
    `virtual-${hashText(clientUri)}.${ext}`,
  )
  return pathToFileURL(filePath).href
}

function resolveLspFileInsideRoot(workspaceRoot: string, filePath: string): string {
  if (
    filePath.includes('\0') ||
    isAbsolute(filePath) ||
    /^[A-Za-z]:[\\/]/.test(filePath) ||
    /^[/\\]{2}/.test(filePath)
  ) {
    throw new Error('LSP file path must be relative')
  }
  const root = resolve(workspaceRoot)
  const target = resolve(root, filePath)
  const rel = relative(root, target)
  if (
    rel === '..' ||
    rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(rel)
  ) {
    throw new Error('LSP file path escapes workspace root')
  }
  return target
}

function serverDocumentKey(serverKey: string, serverUri: string): string {
  return `${serverKey}\0${serverUri}`
}

// ── Raw-LSP → shared-shape normalizers ────────────────────────────────────
// These stay module-level (not methods) because they're pure and the
// request methods below should read as "send request, normalize, return".

function hoverContentsToMarkdown(contents: Hover['contents']): string {
  // LSP hover contents come in three shapes across server generations:
  // MarkupContent ({kind, value}), MarkedString (string | {language,
  // value}), or an array of MarkedStrings. Normalize all of them to one
  // markdown string so the renderer never branches.
  const parts = Array.isArray(contents) ? contents : [contents]
  return parts
    .map(part => {
      if (typeof part === 'string') return part
      if ('kind' in part) return part.value // MarkupContent
      return `\`\`\`${part.language}\n${part.value}\n\`\`\`` // MarkedString
    })
    .filter(Boolean)
    .join('\n\n')
}

function toLspLocation(uri: string, range: Range): LspLocation | null {
  // Servers can return non-file URIs (untitled:, jdt:, …). Only file:
  // URIs are openable by the editor; drop the rest rather than letting
  // fileURLToPath throw on them.
  if (!uri.startsWith('file://')) return null
  return {
    absolutePath: fileURLToPath(uri),
    startLine: range.start.line,
    startCharacter: range.start.character,
    endLine: range.end.line,
    endCharacter: range.end.character,
  }
}

function normalizeDefinitionResult(
  result: Location | Location[] | LocationLink[] | null,
): LspLocation[] {
  if (!result) return []
  const items = Array.isArray(result) ? result : [result]
  const out: LspLocation[] = []
  for (const item of items) {
    if ('targetUri' in item) {
      // LocationLink: targetSelectionRange is the precise symbol span;
      // targetRange is the enclosing construct — the selection range is
      // what "jump to definition" should land on.
      const loc = toLspLocation(item.targetUri, item.targetSelectionRange)
      if (loc) out.push(loc)
    } else {
      const loc = toLspLocation(item.uri, item.range)
      if (loc) out.push(loc)
    }
  }
  return out
}

function normalizeTextEdit(edit: {
  newText: string
  range: Range
}): NonNullable<LspCompletionItem['textEdit']> {
  return {
    newText: edit.newText,
    startLine: edit.range.start.line,
    startCharacter: edit.range.start.character,
    endLine: edit.range.end.line,
    endCharacter: edit.range.end.character,
  }
}

function normalizeCompletionItem(item: CompletionItem, resolveId?: number): LspCompletionItem {
  const label = item.label
  const rawEdit = item.textEdit
  const editRange = rawEdit ? ('range' in rawEdit ? rawEdit.range : rawEdit.replace) : null
  return {
    label,
    kind: item.kind ?? 1,
    insertText: item.insertText ?? label,
    textEdit:
      rawEdit && editRange ? normalizeTextEdit({ ...rawEdit, range: editRange }) : undefined,
    resolveId,
    additionalTextEdits: item.additionalTextEdits?.map(normalizeTextEdit),
    detail: item.detail ?? undefined,
    documentation:
      typeof item.documentation === 'string' ? item.documentation : item.documentation?.value,
    sortText: item.sortText ?? undefined,
    isSnippet: item.insertTextFormat === 2, // InsertTextFormat.Snippet
  }
}

function normalizeSymbols(
  result: DocumentSymbol[] | SymbolInformation[] | null,
): LspDocumentSymbol[] {
  if (!result || result.length === 0) return []
  const MAX_SYMBOLS = 2_000
  const MAX_SYMBOL_DEPTH = 32
  let remaining = MAX_SYMBOLS
  const first = result[0]
  if ('range' in first) {
    const mapSymbol = (symbol: DocumentSymbol, depth: number): LspDocumentSymbol | null => {
      if (remaining <= 0) return null
      remaining -= 1
      const mapped: LspDocumentSymbol = {
        name: symbol.name,
        kind: symbol.kind,
        startLine: symbol.range.start.line,
        startCharacter: symbol.range.start.character,
        endLine: symbol.range.end.line,
        endCharacter: symbol.range.end.character,
        selectionStartLine: symbol.selectionRange.start.line,
        selectionStartCharacter: symbol.selectionRange.start.character,
        selectionEndLine: symbol.selectionRange.end.line,
        selectionEndCharacter: symbol.selectionRange.end.character,
        children: [],
      }
      // WHY preserve parents while bounding preorder: outline consumers need a
      // valid tree, so flattening/slicing after recursive mapping either spends
      // unbounded memory first or produces orphaned children. A bounded preorder
      // keeps the first useful hierarchy and rejects pathological server depth
      // before it can overflow the stack or flood IPC.
      if (depth + 1 < MAX_SYMBOL_DEPTH) {
        for (const child of symbol.children ?? []) {
          const mappedChild = mapSymbol(child, depth + 1)
          if (!mappedChild) break
          mapped.children.push(mappedChild)
        }
      }
      return mapped
    }
    const normalized: LspDocumentSymbol[] = []
    for (const symbol of result as DocumentSymbol[]) {
      const mapped = mapSymbol(symbol, 0)
      if (!mapped) break
      normalized.push(mapped)
    }
    return normalized
  }
  return (result as SymbolInformation[]).slice(0, MAX_SYMBOLS).map(symbol => ({
    name: symbol.name,
    kind: symbol.kind,
    startLine: symbol.location.range.start.line,
    startCharacter: symbol.location.range.start.character,
    endLine: symbol.location.range.end.line,
    endCharacter: symbol.location.range.end.character,
    // SymbolInformation has no separate selection range. Its location is
    // therefore the only truthful navigation range available.
    selectionStartLine: symbol.location.range.start.line,
    selectionStartCharacter: symbol.location.range.start.character,
    selectionEndLine: symbol.location.range.end.line,
    selectionEndCharacter: symbol.location.range.end.character,
    children: [],
  }))
}

export type LspManagerEvents = {
  diagnostics: [LspDiagnosticsEvent]
}

export interface LspManager {
  on<K extends keyof LspManagerEvents>(
    event: K,
    listener: (...args: LspManagerEvents[K]) => void,
  ): this
  off<K extends keyof LspManagerEvents>(
    event: K,
    listener: (...args: LspManagerEvents[K]) => void,
  ): this
  emit<K extends keyof LspManagerEvents>(event: K, ...args: LspManagerEvents[K]): boolean
}

export class LspManager extends EventEmitter {
  private readonly servers = new Map<string, ServerRecord>()
  private readonly docs = new Map<string, OpenDocumentRecord>()
  // LSP document identity belongs to the server URI, not Monaco's client URI.
  // Global Editor and AI Workspace deliberately use distinct Monaco models for
  // independent undo/drafts, yet both can resolve to the same real file URI in
  // one language server. This table owns the one legal didOpen/didClose
  // lifetime and monotonically increasing version for that shared server view.
  private readonly serverDocuments = new Map<string, ServerDocumentRecord>()
  // Single-flight per server key. getOrCreateServer is async (PATH
  // detection via the registry), and a transcript can mount dozens of
  // code blocks in one tick — without coalescing, every one of them would
  // race the "does a server exist yet?" check and spawn a duplicate
  // process. Same pattern (and WHY) as monacoRuntime's
  // pendingSemanticProviders.
  private readonly serverPromises = new Map<string, Promise<ServerRecord | null>>()
  // didOpen/didChange/didClose are an ordered protocol for each client URI,
  // but renderer IPC handlers can overlap while server startup or a stream
  // write is pending. A per-document queue prevents late didOpen from landing
  // after close, and prevents two full-text changes from reordering versions.
  private readonly documentQueues = new Map<string, Promise<void>>()
  private readonly serverDocumentQueues = new Map<string, Promise<void>>()
  // Mutation intent advances before its queued protocol work begins. Language
  // feature requests use the captured epoch to discard a response as soon as
  // the renderer has submitted newer text/close intent, even while that
  // didChange is waiting behind the request's shared-server-URI lock.
  private readonly documentIntentEpochs = new Map<string, number>()
  private completionResolveSequence = 0

  async ensureSemanticLegend(
    workspaceRoot: string,
    language: string,
  ): Promise<SemanticTokensLegend | null> {
    if (!supportsLsp(language)) return null
    const spec = lspServerForLanguage(language)
    if (!spec) return null
    const server = await this.getOrCreateServer(workspaceRoot, spec)
    if (!server) return null
    return await server.legendPromise
  }

  async openDocument(params: OpenDocumentParams): Promise<void> {
    this.bumpDocumentIntent(params.clientUri)
    try {
      await this.serializeDocument(params.clientUri, () => this.openDocumentNow(params))
    } finally {
      this.clearOrphanedDocumentIntent(params.clientUri)
    }
  }

  private async openDocumentNow(params: OpenDocumentParams): Promise<void> {
    if (!supportsLsp(params.language)) return
    const spec = lspServerForLanguage(params.language)
    if (!spec) return
    const language = params.language
    const workspaceRoot = params.workspaceRoot || process.cwd()
    const server = await this.getOrCreateServer(workspaceRoot, spec)
    if (!server) return
    try {
      await server.initialized
    } catch {
      this.discardServer(server)
      return
    }

    const serverUri = params.filePath
      ? pathToFileURL(resolveLspFileInsideRoot(workspaceRoot, params.filePath)).href
      : makeVirtualServerUri(workspaceRoot, params.clientUri, language)
    const key = serverDocumentKey(server.key, serverUri)
    await this.serializeServerDocument(key, async () => {
      const existing = this.docs.get(params.clientUri)
      if (existing) {
        if (existing.serverKey !== server.key || existing.serverUri !== serverUri) {
          // One Monaco URI cannot safely represent two simultaneous server
          // documents. The visible editor will retry on its next mount;
          // mutating the old record here would let its late close tear down the
          // new one.
          return
        }
        const shared = this.serverDocuments.get(key)
        if (!shared) return
        existing.refs += 1
        shared.refs += 1
        await this.changeSharedDocument(server, shared, existing, params.content)
        return
      }

      const shared = this.serverDocuments.get(key)
      if (!shared) {
        await this.sendNotificationIfOpen(server, 'textDocument/didOpen', {
          textDocument: {
            uri: serverUri,
            languageId: language,
            version: 1,
            text: params.content,
          },
        })
        if (server.closed) return
        const created: ServerDocumentRecord = {
          key,
          serverKey: server.key,
          serverUri,
          language,
          version: 1,
          refs: 1,
          content: params.content,
          activeClientUri: params.clientUri,
        }
        this.serverDocuments.set(key, created)
        this.docs.set(params.clientUri, {
          clientUri: params.clientUri,
          serverKey: server.key,
          serverUri,
          serverDocumentKey: key,
          version: 1,
          language,
          refs: 1,
          content: params.content,
          completionItems: new Map(),
        })
        return
      }

      shared.refs += 1
      const doc: OpenDocumentRecord = {
        clientUri: params.clientUri,
        serverKey: server.key,
        serverUri,
        serverDocumentKey: key,
        version: shared.version,
        language,
        refs: 1,
        content: params.content,
        completionItems: new Map(),
      }
      this.docs.set(params.clientUri, doc)
      await this.changeSharedDocument(server, shared, doc, params.content)
    })
  }

  async changeDocument(clientUri: string, content: string): Promise<void> {
    this.bumpDocumentIntent(clientUri)
    try {
      await this.serializeDocument(clientUri, () => this.changeDocumentNow(clientUri, content))
    } finally {
      this.clearOrphanedDocumentIntent(clientUri)
    }
  }

  private async changeDocumentNow(clientUri: string, content: string): Promise<void> {
    const doc = this.docs.get(clientUri)
    if (!doc) return
    await this.serializeServerDocument(doc.serverDocumentKey, async () => {
      if (this.docs.get(clientUri) !== doc) return
      const server = this.servers.get(doc.serverKey)
      const shared = this.serverDocuments.get(doc.serverDocumentKey)
      if (!server || !shared) return
      await this.changeSharedDocument(server, shared, doc, content)
    })
  }

  private async changeSharedDocument(
    server: ServerRecord,
    shared: ServerDocumentRecord,
    source: OpenDocumentRecord,
    content: string,
  ): Promise<void> {
    source.content = content
    shared.activeClientUri = source.clientUri
    if (shared.content === content) {
      source.version = shared.version
      source.completionItems.clear()
      return
    }
    shared.content = content
    shared.version += 1
    // Completion resolve handles describe the server's view at the time the
    // list was produced. A change through either surface invalidates handles
    // for every client alias of this real URI, not just the writer.
    for (const doc of this.docs.values()) {
      if (doc.serverDocumentKey !== shared.key) continue
      doc.version = shared.version
      doc.completionItems.clear()
      // Diagnostics describe the prior shared server text until a fresh
      // publish arrives. Every alias may have a different draft, so retaining
      // those markers after switching the server view makes the inactive
      // surface's errors appear on the newly active one.
      this.emit('diagnostics', { clientUri: doc.clientUri, diagnostics: [] })
    }
    await this.sendNotificationIfOpen(server, 'textDocument/didChange', {
      textDocument: { uri: shared.serverUri, version: shared.version },
      contentChanges: [{ text: content }],
    })
  }

  async closeDocument(clientUri: string): Promise<void> {
    this.bumpDocumentIntent(clientUri)
    try {
      await this.serializeDocument(clientUri, () => this.closeDocumentNow(clientUri))
    } finally {
      this.clearOrphanedDocumentIntent(clientUri)
    }
  }

  private async closeDocumentNow(clientUri: string): Promise<void> {
    const doc = this.docs.get(clientUri)
    if (!doc) return
    await this.serializeServerDocument(doc.serverDocumentKey, async () => {
      if (this.docs.get(clientUri) !== doc) return
      const shared = this.serverDocuments.get(doc.serverDocumentKey)
      if (!shared) {
        this.docs.delete(clientUri)
        this.emit('diagnostics', { clientUri, diagnostics: [] })
        return
      }
      // Multiple mounts of one client URI and multiple client aliases of one
      // server URI are separate refcount layers. Only the final server ref may
      // emit didClose; closing the active alias first restores a surviving
      // alias's draft so the server never keeps content owned by a dead view.
      doc.refs -= 1
      shared.refs -= 1
      if (doc.refs > 0) return
      this.docs.delete(clientUri)
      this.emit('diagnostics', { clientUri, diagnostics: [] })
      const server = this.servers.get(doc.serverKey)
      if (shared.refs <= 0) {
        if (server) {
          await this.sendNotificationIfOpen(server, 'textDocument/didClose', {
            textDocument: { uri: shared.serverUri },
          })
        }
        this.serverDocuments.delete(shared.key)
        return
      }
      if (shared.activeClientUri !== clientUri || !server) return
      const survivor = [...this.docs.values()].find(
        candidate => candidate.serverDocumentKey === shared.key,
      )
      if (survivor) await this.changeSharedDocument(server, shared, survivor, survivor.content)
    })
  }

  async getSemanticTokens(clientUri: string): Promise<SemanticTokens | null> {
    return await this.sendDocRequest<SemanticTokens>(
      clientUri,
      'textDocument/semanticTokens/full',
      {},
    )
  }

  // ── Editor language-feature requests ────────────────────────────────
  // All follow the getSemanticTokens shape: doc lookup → server lookup →
  // await initialized → sendRequest → normalize. Unknown clientUris fail
  // open with an empty result — providers in the renderer are global per
  // Monaco language, so they legitimately fire for models (e.g. closed
  // tabs mid-teardown) that no longer have an LSP doc.

  private requestContext(
    clientUri: string,
  ): { doc: OpenDocumentRecord; server: ServerRecord } | null {
    const doc = this.docs.get(clientUri)
    if (!doc) return null
    const server = this.servers.get(doc.serverKey)
    if (!server) return null
    return { doc, server }
  }

  private async sendDocRequest<T>(
    clientUri: string,
    method: string,
    extraParams: Record<string, unknown>,
  ): Promise<T | null> {
    // Capture at invocation time, before joining the per-client queue. If a
    // change was invoked first, the request queues behind it with the same
    // epoch. If a change arrives later, it advances the map immediately and
    // invalidates this response even though protocol ordering makes the
    // didChange wait for the request to release the server-URI queue.
    const intentEpoch = this.documentIntentEpochs.get(clientUri) ?? 0
    try {
      return await this.serializeDocument(clientUri, async () => {
        if ((this.documentIntentEpochs.get(clientUri) ?? 0) !== intentEpoch) return null
        const ctx = this.requestContext(clientUri)
        if (!ctx) return null
        await ctx.server.initialized
        if ((this.documentIntentEpochs.get(clientUri) ?? 0) !== intentEpoch) return null
        return await this.serializeServerDocument(ctx.doc.serverDocumentKey, async () => {
          if (
            this.docs.get(clientUri) !== ctx.doc ||
            (this.documentIntentEpochs.get(clientUri) ?? 0) !== intentEpoch
          ) {
            return null
          }
          const shared = this.serverDocuments.get(ctx.doc.serverDocumentKey)
          if (!shared || this.servers.get(ctx.doc.serverKey) !== ctx.server) return null
          // Monaco models intentionally have per-surface client URIs, but the
          // language server sees one real file URI. Restore the requesting draft
          // while holding the same URI queue through the response; a renderer-side
          // didChange followed by a separate request still leaves an interleaving
          // window where another surface can become active between those IPCs.
          if (shared.activeClientUri !== clientUri || shared.content !== ctx.doc.content) {
            await this.changeSharedDocument(ctx.server, shared, ctx.doc, ctx.doc.content)
          }

          const cancellation = new CancellationTokenSource()
          let timeout: ReturnType<typeof setTimeout> | undefined
          try {
            const response = await Promise.race([
              ctx.server.connection.sendRequest<T>(
                method,
                {
                  textDocument: { uri: ctx.doc.serverUri },
                  ...extraParams,
                },
                cancellation.token,
              ),
              new Promise<typeof LSP_REQUEST_TIMED_OUT>(resolveTimeout => {
                timeout = setTimeout(() => {
                  // Cancellation is advisory in LSP. The local timeout is what
                  // releases our queues even when a wedged server ignores it;
                  // the token merely gives healthy servers a chance to stop the
                  // now-useless computation.
                  cancellation.cancel()
                  resolveTimeout(LSP_REQUEST_TIMED_OUT)
                }, LSP_DOCUMENT_REQUEST_TIMEOUT_MS)
              }),
            ])
            if (response === LSP_REQUEST_TIMED_OUT) return null
            if (
              this.docs.get(clientUri) !== ctx.doc ||
              (this.documentIntentEpochs.get(clientUri) ?? 0) !== intentEpoch
            ) {
              return null
            }
            return response
          } catch (err) {
            if (isDestroyedStreamError(err) || ctx.server.closed) return null
            throw err
          } finally {
            if (timeout) clearTimeout(timeout)
            cancellation.dispose()
          }
        })
      })
    } finally {
      this.clearOrphanedDocumentIntent(clientUri)
    }
  }

  async getHover(clientUri: string, position: LspPosition): Promise<LspHoverResult> {
    const hover = await this.sendDocRequest<Hover | null>(clientUri, 'textDocument/hover', {
      position,
    })
    if (!hover) return null
    const markdown = hoverContentsToMarkdown(hover.contents)
    return markdown ? { markdown } : null
  }

  async getDefinition(clientUri: string, position: LspPosition): Promise<LspLocation[]> {
    const result = await this.sendDocRequest<Location | Location[] | LocationLink[] | null>(
      clientUri,
      'textDocument/definition',
      { position },
    )
    return normalizeDefinitionResult(result)
  }

  async getCompletions(
    clientUri: string,
    position: LspPosition,
    context: LspCompletionContext,
  ): Promise<LspCompletionResult> {
    await this.waitForDocument(clientUri)
    const requestedDoc = this.docs.get(clientUri)
    const requestedVersion = requestedDoc?.version
    if (!requestedDoc) return { items: [], incomplete: false }
    const result = await this.sendDocRequest<CompletionItem[] | CompletionList | null>(
      clientUri,
      'textDocument/completion',
      { position, context },
    )
    const doc = this.docs.get(clientUri)
    // Cancellation is advisory and can race a server response. Keep this
    // version proof as a second boundary: if the user typed while the server
    // was answering, never repopulate resolve handles for the older text.
    if (doc !== requestedDoc || doc.version !== requestedVersion || !result) {
      return { items: [], incomplete: false }
    }
    const items = Array.isArray(result) ? result : result.items
    // Our transport cap is also an incomplete list from Monaco's point of
    // view. Mark it as such even when the server returned a complete larger
    // list so narrowing input gets a fresh request instead of filtering only
    // the first 200 forever.
    const incomplete = (!Array.isArray(result) && result.isIncomplete) || items.length > 200
    doc.completionItems.clear()
    // Cap: tsserver returns 1k+ global symbols on a bare identifier;
    // IPC-serializing all of them per keystroke is renderer jank for entries
    // nobody scrolls to. Servers front-load relevance via sortText, and Monaco
    // re-filters client-side as the user types more.
    const normalizedItems = items.slice(0, 200).map(item => {
      const resolveId = ++this.completionResolveSequence
      doc.completionItems.set(resolveId, item)
      return normalizeCompletionItem(item, resolveId)
    })
    return { items: normalizedItems, incomplete }
  }

  async resolveCompletion(clientUri: string, resolveId: number): Promise<LspCompletionItem | null> {
    await this.waitForDocument(clientUri)
    const ctx = this.requestContext(clientUri)
    const item = ctx?.doc.completionItems.get(resolveId)
    if (!ctx || !item) return null
    const requestedVersion = ctx.doc.version
    const initialized = await ctx.server.initialized
    if (!initialized.capabilities.completionProvider?.resolveProvider) {
      return this.docs.get(clientUri) === ctx.doc && ctx.doc.version === requestedVersion
        ? normalizeCompletionItem(item, resolveId)
        : null
    }
    try {
      const cancellation = new CancellationTokenSource()
      let timeout: ReturnType<typeof setTimeout> | undefined
      let response: CompletionItem | typeof LSP_REQUEST_TIMED_OUT
      try {
        response = await Promise.race([
          ctx.server.connection.sendRequest<CompletionItem>(
            'completionItem/resolve',
            item,
            cancellation.token,
          ),
          new Promise<typeof LSP_REQUEST_TIMED_OUT>(resolveTimeout => {
            timeout = setTimeout(() => {
              cancellation.cancel()
              resolveTimeout(LSP_REQUEST_TIMED_OUT)
            }, LSP_DOCUMENT_REQUEST_TIMEOUT_MS)
          }),
        ])
      } finally {
        if (timeout) clearTimeout(timeout)
        cancellation.dispose()
      }
      // Resolve enriches a suggestion after it is already usable. A hung
      // details request must never leave Monaco's completion UI waiting
      // indefinitely; keep the original item as the graceful fallback.
      if (response === LSP_REQUEST_TIMED_OUT) {
        return this.docs.get(clientUri) === ctx.doc && ctx.doc.version === requestedVersion
          ? normalizeCompletionItem(item, resolveId)
          : null
      }
      if (
        this.docs.get(clientUri) !== ctx.doc ||
        ctx.doc.version !== requestedVersion ||
        ctx.doc.completionItems.get(resolveId) !== item
      ) {
        return null
      }
      // Some servers return only the fields populated during resolve even
      // though the protocol describes a full CompletionItem. Merge over the
      // main-owned original so labels, snippets, and precomputed edits cannot
      // disappear when one of those pragmatic partial responses arrives.
      const resolved = { ...item, ...response }
      // Preserve the opaque handle because Monaco may call resolve again as
      // its details widget reopens. The main-owned raw item remains the only
      // protocol payload accepted from renderer.
      ctx.doc.completionItems.set(resolveId, resolved)
      return normalizeCompletionItem(resolved, resolveId)
    } catch (err) {
      if (isDestroyedStreamError(err) || ctx.server.closed) return null
      throw err
    }
  }

  async getReferences(clientUri: string, position: LspPosition): Promise<LspLocation[]> {
    const result = await this.sendDocRequest<Location[] | null>(
      clientUri,
      'textDocument/references',
      { position, context: { includeDeclaration: false } },
    )
    if (!result) return []
    const out: LspLocation[] = []
    // Cap mirrors the completion cap's rationale — a popular symbol in a
    // big repo can reference thousands of sites; the peek widget shows a
    // scrollable subset and nobody reads past a few hundred.
    for (const location of result.slice(0, 500)) {
      const loc = toLspLocation(location.uri, location.range)
      if (loc) out.push(loc)
    }
    return out
  }

  async getDocumentSymbols(clientUri: string): Promise<LspDocumentSymbol[]> {
    const result = await this.sendDocRequest<DocumentSymbol[] | SymbolInformation[] | null>(
      clientUri,
      'textDocument/documentSymbol',
      {},
    )
    return normalizeSymbols(result)
  }

  async dispose(): Promise<void> {
    // dispose is terminal, so collapse refcounts before routing through the
    // normal close path. Calling close once per URI while refs > 1 would leave
    // records pointing at servers that are about to be killed.
    for (const doc of this.docs.values()) doc.refs = 1
    for (const shared of this.serverDocuments.values()) {
      shared.refs = [...this.docs.values()].filter(
        doc => doc.serverDocumentKey === shared.key,
      ).length
    }
    for (const clientUri of [...this.docs.keys()]) {
      await this.closeDocument(clientUri)
    }
    for (const server of this.servers.values()) {
      server.closed = true
      server.connection.dispose()
      server.process.kill()
    }
    this.servers.clear()
    this.serverDocuments.clear()
    this.documentIntentEpochs.clear()
  }

  private bumpDocumentIntent(clientUri: string): number {
    const next = (this.documentIntentEpochs.get(clientUri) ?? 0) + 1
    this.documentIntentEpochs.set(clientUri, next)
    return next
  }

  private clearOrphanedDocumentIntent(clientUri: string): void {
    // Failed/unsupported opens never create a doc, while final close and
    // crashed servers remove one. Retaining their epochs forever would turn
    // every transient CodeBlock URI into a process-lifetime map entry.
    if (!this.docs.has(clientUri) && !this.documentQueues.has(clientUri)) {
      this.documentIntentEpochs.delete(clientUri)
    }
  }

  private async serializeDocument<T>(clientUri: string, task: () => Promise<T>): Promise<T> {
    const previous = this.documentQueues.get(clientUri) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(task)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.documentQueues.set(clientUri, tail)
    try {
      return await result
    } finally {
      if (this.documentQueues.get(clientUri) === tail) this.documentQueues.delete(clientUri)
    }
  }

  private async waitForDocument(clientUri: string): Promise<void> {
    await this.documentQueues.get(clientUri)?.catch(() => undefined)
  }

  private async serializeServerDocument<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.serverDocumentQueues.get(key) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(task)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.serverDocumentQueues.set(key, tail)
    try {
      return await result
    } finally {
      if (this.serverDocumentQueues.get(key) === tail) this.serverDocumentQueues.delete(key)
    }
  }

  private getOrCreateServer(
    workspaceRoot: string,
    spec: LspServerSpec,
  ): Promise<ServerRecord | null> {
    // Composite key: one server per (workspace root × server spec). A
    // root that mixes TS and Python gets one tsserver AND one pyright,
    // each seeing the same rootUri.
    const key = `${resolve(workspaceRoot)}::${spec.id}`
    const existing = this.servers.get(key)
    if (existing && !existing.closed) return Promise.resolve(existing)
    if (existing?.closed) this.servers.delete(key)
    const pending = this.serverPromises.get(key)
    if (pending) return pending

    const creation = this.createServer(resolve(workspaceRoot), key, spec).finally(() => {
      this.serverPromises.delete(key)
    })
    this.serverPromises.set(key, creation)
    return creation
  }

  private async createServer(
    rootAbs: string,
    key: string,
    spec: LspServerSpec,
  ): Promise<ServerRecord | null> {
    // The registry owns HOW to spawn (bundled tsserver via
    // ELECTRON_RUN_AS_NODE, others via PATH detection); null means the
    // server simply isn't installed — fail open, the editor works without
    // LSP for that language.
    const resolved = await spec.resolveCommand()
    if (!resolved) return null

    const child = spawn(resolved.command, resolved.args, {
      cwd: rootAbs,
      stdio: 'pipe',
      env: {
        ...process.env,
        ...resolved.env,
      },
    })

    const connection = createMessageConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin),
    )

    connection.onNotification(
      'textDocument/publishDiagnostics',
      (params: PublishDiagnosticsParams) => this.handlePublishDiagnostics(key, params),
    )

    connection.listen()

    const initializeParams: InitializeParams = {
      processId: process.pid,
      // rootAbs, NOT the composite `key` — the key carries a `::specId`
      // suffix that must never leak into file URIs.
      rootUri: pathToFileURL(rootAbs).href,
      capabilities: {
        textDocument: {
          semanticTokens: {
            dynamicRegistration: false,
            requests: { full: true, range: false },
            tokenTypes: [],
            tokenModifiers: [],
            formats: ['relative'],
          },
          publishDiagnostics: {
            relatedInformation: false,
          },
          // Editor language features (#513). Declared here so servers
          // advertise/emit the richer response shapes; the normalizers at
          // the top of this file handle the older fallbacks anyway.
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { linkSupport: true },
          completion: {
            completionItem: {
              snippetSupport: true,
              documentationFormat: ['markdown', 'plaintext'],
            },
          },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        },
        workspace: {
          configuration: false,
        },
      },
      workspaceFolders: [
        {
          uri: pathToFileURL(rootAbs).href,
          name: rootAbs.split('/').pop() ?? rootAbs,
        },
      ],
    }

    const initializeCancellation = new CancellationTokenSource()
    const initializeRequest = connection.sendRequest<InitializeResult>(
      'initialize',
      initializeParams,
      initializeCancellation.token,
    )
    const initialized = new Promise<InitializeResult>((resolve, reject) => {
      // A process can spawn successfully yet never speak LSP (broken shim,
      // corrupt runtime, or a server blocked during startup). Every didOpen for
      // this root waits on initialization, so leaving this unbounded wedges all
      // later change/close operations and retains the dead child indefinitely.
      // Cancellation is advisory; rejecting the owned promise is the hard
      // bound, and the existing rejection path disposes/kills the server.
      const timeout = setTimeout(() => {
        initializeCancellation.cancel()
        initializeCancellation.dispose()
        reject(
          new Error(
            `language server initialization timed out after ${LSP_INITIALIZE_TIMEOUT_MS}ms`,
          ),
        )
      }, LSP_INITIALIZE_TIMEOUT_MS)
      timeout.unref()
      initializeRequest.then(
        result => {
          clearTimeout(timeout)
          initializeCancellation.dispose()
          resolve(result)
        },
        error => {
          clearTimeout(timeout)
          initializeCancellation.dispose()
          reject(error)
        },
      )
    })
    initialized
      .then(() => {
        const server = this.servers.get(key)
        if (!server) return
        void this.sendNotificationIfOpen(server, 'initialized', {})
      })
      .catch(() => {})

    const legendPromise = initialized
      .then(result => result.capabilities.semanticTokensProvider?.legend ?? null)
      .catch(() => null)

    const record: ServerRecord = {
      key,
      specId: spec.id,
      workspaceRoot: rootAbs,
      process: child,
      connection,
      initialized,
      legendPromise,
      closed: false,
    }

    child.on('error', () => {
      this.discardServer(record)
    })

    child.on('exit', () => {
      this.discardServer(record, false)
    })

    this.servers.set(key, record)
    void initialized.catch(() => this.discardServer(record))
    return record
  }

  private handlePublishDiagnostics(serverKey: string, params: PublishDiagnosticsParams): void {
    const shared = this.serverDocuments.get(serverDocumentKey(serverKey, params.uri))
    // Alias content equality alone cannot identify a delayed publish: A's v3
    // diagnostics may arrive after B made the shared URI v4, at which point
    // comparing only current text can paint those old markers onto B. Servers
    // that provide the protocol version give us an exact ordering proof; drop
    // stale publishes rather than clearing a newer marker set with old news.
    if (params.version != null && params.version !== shared?.version) return
    for (const doc of this.docs.values()) {
      if (doc.serverKey !== serverKey || doc.serverUri !== params.uri) continue
      this.emit('diagnostics', {
        clientUri: doc.clientUri,
        // A publish belongs to the current server text. Aliases with an
        // independent draft must stay marker-free until their next request
        // restores that draft and the server publishes for it. Versionless
        // servers remain best-effort because the protocol offers no stronger
        // ordering identity for them.
        diagnostics:
          shared?.content === doc.content
            ? params.diagnostics.map(diagnostic => ({
                message: diagnostic.message,
                severity: toSeverity(diagnostic.severity),
                startLine: diagnostic.range.start.line,
                startCharacter: diagnostic.range.start.character,
                endLine: diagnostic.range.end.line,
                endCharacter: diagnostic.range.end.character,
              }))
            : [],
      })
    }
  }

  private discardServer(server: ServerRecord, kill = true): void {
    if (this.servers.get(server.key) === server) this.servers.delete(server.key)
    if (!server.closed) {
      server.closed = true
      try {
        server.connection.dispose()
      } catch {
        // A spawn/initialize failure can tear streams down first.
      }
      if (kill && !server.process.killed) server.process.kill()
    }
    for (const doc of [...this.docs.values()]) {
      if (doc.serverKey !== server.key) continue
      this.docs.delete(doc.clientUri)
      this.documentIntentEpochs.delete(doc.clientUri)
      this.emit('diagnostics', { clientUri: doc.clientUri, diagnostics: [] })
    }
    for (const [key, doc] of this.serverDocuments) {
      if (doc.serverKey === server.key) this.serverDocuments.delete(key)
    }
  }

  private async sendNotificationIfOpen(
    server: ServerRecord,
    method: string,
    params: unknown,
  ): Promise<void> {
    if (server.closed || server.process.killed || server.process.stdin.destroyed) return

    try {
      await server.connection.sendNotification(method, params)
    } catch (err) {
      if (isDestroyedStreamError(err)) {
        this.discardServer(server, false)
        return
      }
      throw err
    }
  }
}

function isDestroyedStreamError(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ERR_STREAM_DESTROYED'
}
