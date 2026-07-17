import { EventEmitter } from 'events'
import { spawn } from 'child_process'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { isAbsolute, relative, resolve } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

import {
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
  version: number
  language: string
  refs: number
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

function normalizeCompletionResult(
  result: CompletionItem[] | CompletionList | null,
): LspCompletionItem[] {
  const items = Array.isArray(result) ? result : (result?.items ?? [])
  // Cap: tsserver returns 1k+ global symbols on a bare identifier;
  // IPC-serializing all of them per keystroke is renderer jank for
  // entries nobody scrolls to. Servers front-load relevance via sortText,
  // and Monaco re-filters client-side as the user types more.
  return items.slice(0, 200).map(item => {
    const label = item.label
    const rawEdit = item.textEdit
    const editRange = rawEdit ? ('range' in rawEdit ? rawEdit.range : rawEdit.replace) : null
    return {
      label,
      kind: item.kind ?? 1,
      insertText: item.insertText ?? label,
      textEdit:
        rawEdit && editRange
          ? {
              newText: rawEdit.newText,
              startLine: editRange.start.line,
              startCharacter: editRange.start.character,
              endLine: editRange.end.line,
              endCharacter: editRange.end.character,
            }
          : undefined,
      detail: item.detail ?? undefined,
      documentation:
        typeof item.documentation === 'string' ? item.documentation : item.documentation?.value,
      sortText: item.sortText ?? undefined,
      isSnippet: item.insertTextFormat === 2, // InsertTextFormat.Snippet
    }
  })
}

function normalizeSymbols(
  result: DocumentSymbol[] | SymbolInformation[] | null,
): LspDocumentSymbol[] {
  if (!result || result.length === 0) return []
  const first = result[0]
  if ('range' in first) {
    const mapSymbol = (symbol: DocumentSymbol): LspDocumentSymbol => ({
      name: symbol.name,
      kind: symbol.kind,
      startLine: symbol.selectionRange.start.line,
      startCharacter: symbol.selectionRange.start.character,
      endLine: symbol.selectionRange.end.line,
      endCharacter: symbol.selectionRange.end.character,
      children: (symbol.children ?? []).map(mapSymbol),
    })
    return (result as DocumentSymbol[]).map(mapSymbol)
  }
  return (result as SymbolInformation[]).map(symbol => ({
    name: symbol.name,
    kind: symbol.kind,
    startLine: symbol.location.range.start.line,
    startCharacter: symbol.location.range.start.character,
    endLine: symbol.location.range.end.line,
    endCharacter: symbol.location.range.end.character,
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
  // Single-flight per server key. getOrCreateServer is async (PATH
  // detection via the registry), and a transcript can mount dozens of
  // code blocks in one tick — without coalescing, every one of them would
  // race the "does a server exist yet?" check and spawn a duplicate
  // process. Same pattern (and WHY) as monacoRuntime's
  // pendingSemanticProviders.
  private readonly serverPromises = new Map<string, Promise<ServerRecord | null>>()

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
    const existing = this.docs.get(params.clientUri)
    if (existing) {
      if (existing.serverKey !== server.key || existing.serverUri !== serverUri) {
        // One Monaco URI cannot safely represent two simultaneous server
        // documents. The visible editor will retry on its next mount; mutating
        // the old record here would let its late close tear down the new one.
        return
      }
      existing.refs += 1
      await this.changeDocument(params.clientUri, params.content)
      return
    }

    await this.sendNotificationIfOpen(server, 'textDocument/didOpen', {
      textDocument: {
        uri: serverUri,
        languageId: language,
        version: 1,
        text: params.content,
      },
    })
    if (server.closed) return

    this.docs.set(params.clientUri, {
      clientUri: params.clientUri,
      serverKey: server.key,
      serverUri,
      version: 1,
      language,
      refs: 1,
    })
  }

  async changeDocument(clientUri: string, content: string): Promise<void> {
    const doc = this.docs.get(clientUri)
    if (!doc) return
    const server = this.servers.get(doc.serverKey)
    if (!server) return
    doc.version += 1
    await this.sendNotificationIfOpen(server, 'textDocument/didChange', {
      textDocument: {
        uri: doc.serverUri,
        version: doc.version,
      },
      contentChanges: [{ text: content }],
    })
  }

  async closeDocument(clientUri: string): Promise<void> {
    const doc = this.docs.get(clientUri)
    if (!doc) return
    // Multiple editor surfaces can temporarily mount the same Monaco URI
    // during React transitions. didClose is a lifetime operation, not a
    // content change: only the last owner may tear down the server document.
    // Keeping the decrement here (and never in changeDocument) preserves both
    // live diagnostics and later changes from whichever owner survives.
    doc.refs -= 1
    if (doc.refs > 0) return
    const server = this.servers.get(doc.serverKey)
    if (server) {
      await this.sendNotificationIfOpen(server, 'textDocument/didClose', {
        textDocument: { uri: doc.serverUri },
      })
    }
    this.docs.delete(clientUri)
    this.emit('diagnostics', { clientUri, diagnostics: [] })
  }

  async getSemanticTokens(clientUri: string): Promise<SemanticTokens | null> {
    const doc = this.docs.get(clientUri)
    if (!doc) return null
    const server = this.servers.get(doc.serverKey)
    if (!server) return null
    await server.initialized
    try {
      return await server.connection.sendRequest('textDocument/semanticTokens/full', {
        textDocument: { uri: doc.serverUri },
      })
    } catch (err) {
      if (isDestroyedStreamError(err) || server.closed) return null
      throw err
    }
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
    const ctx = this.requestContext(clientUri)
    if (!ctx) return null
    await ctx.server.initialized
    try {
      return (await ctx.server.connection.sendRequest(method, {
        textDocument: { uri: ctx.doc.serverUri },
        ...extraParams,
      })) as T
    } catch (err) {
      if (isDestroyedStreamError(err) || ctx.server.closed) return null
      throw err
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

  async getCompletions(clientUri: string, position: LspPosition): Promise<LspCompletionItem[]> {
    const result = await this.sendDocRequest<CompletionItem[] | CompletionList | null>(
      clientUri,
      'textDocument/completion',
      { position },
    )
    return normalizeCompletionResult(result)
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
    for (const clientUri of this.docs.keys()) {
      await this.closeDocument(clientUri)
    }
    for (const server of this.servers.values()) {
      server.closed = true
      server.connection.dispose()
      server.process.kill()
    }
    this.servers.clear()
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
      (params: PublishDiagnosticsParams) => {
        for (const doc of this.docs.values()) {
          if (doc.serverKey !== key || doc.serverUri !== params.uri) continue
          this.emit('diagnostics', {
            clientUri: doc.clientUri,
            diagnostics: params.diagnostics.map(diagnostic => ({
              message: diagnostic.message,
              severity: toSeverity(diagnostic.severity),
              startLine: diagnostic.range.start.line,
              startCharacter: diagnostic.range.start.character,
              endLine: diagnostic.range.end.line,
              endCharacter: diagnostic.range.end.character,
            })),
          })
        }
      },
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

    const initialized = connection.sendRequest(
      'initialize',
      initializeParams,
    ) as Promise<InitializeResult>
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
      this.emit('diagnostics', { clientUri: doc.clientUri, diagnostics: [] })
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
