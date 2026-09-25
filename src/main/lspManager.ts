import { randomUUID } from 'node:crypto'
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
  /** The server GENERATION that owns this document (#921). */
  serverGeneration: string
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
  /** The server GENERATION that owns this document (#921). */
  serverGeneration: string
  serverUri: string
  language: string
  version: number
  refs: number
  content: string
  activeClientUri: string
}

type ServerRecord = {
  key: string
  /**
   * Identity of THIS server process, distinct from `key` (#921).
   *
   * `key` is derived from the language spec and workspace root, so a
   * replacement server spawned after a crash reuses it. Anything that fences
   * cleanup on `key` alone cannot tell the dead server from the live one that
   * took its place — see `discardServer`.
   */
  generation: string
  specId: string
  workspaceRoot: string
  process: ChildProcessWithoutNullStreams
  connection: MessageConnection
  initialized: Promise<InitializeResult>
  legendPromise: Promise<SemanticTokensLegend | null>
  closed: boolean
  /**
   * Requests we stopped waiting for that the server has still not answered
   * (#924). Increments when a request is abandoned past its grace period,
   * decrements when the server finally replies, and is the input to
   * `LSP_MAX_ABANDONED_REQUESTS`.
   */
  abandonedRequests: number
}

/**
 * A fresh identity for one server PROCESS (#921).
 *
 * Named and exported rather than inlined at the single call site so the one
 * property the fence depends on — that a replacement never shares its
 * predecessor's value — is reachable by a test. The suite cannot drive
 * `createServer` without spawning a real language server, so without this the
 * only thing standing between a working fence and a useless one would be that
 * nobody replaced `randomUUID()` with a constant.
 */
export function nextServerGeneration(): string {
  return randomUUID()
}

const LSP_DOCUMENT_REQUEST_TIMEOUT_MS = 15_000
/**
 * How long a request whose answer is ALREADY known to be worthless may keep
 * holding the document queues (#924).
 *
 * WHY a second, much smaller budget rather than reusing the 15 s request
 * timeout: those two numbers answer different questions. 15 s is "how long do
 * we wait for an answer we still want"; this is "how long do we keep the
 * user's next keystroke waiting behind an answer we have already decided to
 * throw away". A newer intent (a change, a close, a fresh request) invalidates
 * the in-flight response the moment it arrives, but before #924 the queues
 * stayed held until the server replied or the full 15 s elapsed — and
 * cancellation is ADVISORY in LSP, so a server is entitled to ignore it. That
 * made synchronizing what the user just typed wait out a dead request.
 *
 * Zero would be wrong: the response usually arrives within a few event-loop
 * turns of the cancellation, and taking it means the next request does not
 * have to re-synchronize. This is a grace period, not a deadline.
 */
const LSP_ABANDONED_REQUEST_GRACE_MS = 250

/**
 * How many abandoned-but-unanswered requests one server may accumulate before
 * we stop believing in it (#924).
 *
 * A healthy server answers a cancelled request quickly, even if only with an
 * error, so this counter should hover at zero. A server that ignores
 * cancellation AND never answers leaks one pending RPC per abandonment, and
 * the LSP connection holds a response handler for each. The cap turns an
 * unbounded leak into a bounded one followed by a deliberate restart: the next
 * edit of a backed document re-opens it on a fresh process (ipc/lsp.ts). A
 * request only counts once it has stayed unanswered for the full request
 * budget after being abandoned — see `noteAbandonedRequest` for why a shorter
 * window retired healthy servers that were merely busy.
 */
const LSP_MAX_ABANDONED_REQUESTS = 32

/**
 * What a request was actually asked about, captured AFTER synchronization.
 *
 * WHY it cannot be captured before (#923): a request from an inactive client
 * alias has to push that alias's draft onto the shared server document first,
 * and `changeSharedDocument` advances `version` on EVERY alias of that URI —
 * including the requesting one. `getCompletions` captured the version before
 * `sendDocRequest` ran, so its final "did the text change under me?" check
 * compared the pre-sync number against the post-sync one and threw away the
 * result of its own synchronization. Deterministic, not a race: it happened on
 * every completion from the inactive half of a split view.
 */
type DocRequestTicket = {
  doc: OpenDocumentRecord
  /** The requesting alias's revision AFTER its draft was restored. */
  clientVersion: number
}
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
  /**
   * Who to wake when someone intends to change a SERVER DOCUMENT (#924).
   *
   * The epoch map alone can only be POLLED, and the one place that needs to
   * react to it is blocked on a server that may never answer. This is the
   * push half: `bumpDocumentIntent` notifies, and an in-flight request stops
   * waiting instead of holding its queues until the 15 s timeout.
   *
   * WHY this is keyed by `serverDocumentKey` and not by client URI (#1108
   * review, 1): the queue that actually blocks is the SERVER-document queue.
   * Monaco gives two surfaces on one disk file two different model URIs on
   * purpose (`editorModelRegistry`, so they never share text or undo state),
   * and both map to one server document. Keyed by client URI, a request from
   * alias A kept holding that queue while the user typed in alias B — B's
   * didChange waited out the full 15 s, which is this issue's symptom verbatim
   * in the exact split-view scenario #923 is about.
   *
   * Any intent on the shared document abandons the in-flight request. That
   * is almost always free: a change of ANY alias rewrites the shared text and
   * `changeSharedDocument` advances `version` on every alias, so the answer we
   * are still waiting for would be rejected by the ticket check anyway.
   *
   * It is NOT free in two cases, and the cost is accepted: opening another
   * surface with identical text, or closing a sibling surface, wakes the
   * request although the shared text did not change (`changeSharedDocument`
   * returns early on identical text without bumping `version`). The answer
   * was still valid and is dropped: one hover, completion or semantic-token
   * round, which the editor re-requests on its next trigger. Distinguishing
   * "intent that changes the text" from "intent that does not" would need the
   * wake to know the post-intent text, which is exactly what it does not wait
   * for. One lost answer beats a keystroke waiting out 15 s.
   */
  private readonly documentIntentWaiters = new Map<string, Set<() => void>>()
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

  /**
   * Open (or attach to) the server document for this client URI.
   *
   * Answers whether a document now EXISTS for it (#1108 review, 3). Several
   * ordinary paths legitimately produce none — an unsupported language, a
   * language whose server binary is not installed, a spawn or initialize
   * failure — and every one of those is documented as FAIL OPEN: the editor
   * works, just without LSP. The caller needs that apart from "the open
   * failed", because a later change for a URI that was never LSP-backed is a
   * no-op, while a change for one that WAS is the silent loss #922 is about.
   */
  async openDocument(params: OpenDocumentParams): Promise<boolean> {
    this.bumpDocumentIntent(params.clientUri)
    try {
      return await this.serializeDocument(params.clientUri, () => this.openDocumentNow(params))
    } finally {
      this.clearOrphanedDocumentIntent(params.clientUri)
    }
  }

  private async openDocumentNow(params: OpenDocumentParams): Promise<boolean> {
    if (!supportsLsp(params.language)) return false
    const spec = lspServerForLanguage(params.language)
    if (!spec) return false
    const language = params.language
    const workspaceRoot = params.workspaceRoot || process.cwd()
    const server = await this.getOrCreateServer(workspaceRoot, spec)
    if (!server) return false
    try {
      await server.initialized
    } catch {
      this.discardServer(server)
      return false
    }

    const serverUri = params.filePath
      ? pathToFileURL(resolveLspFileInsideRoot(workspaceRoot, params.filePath)).href
      : makeVirtualServerUri(workspaceRoot, params.clientUri, language)
    const key = serverDocumentKey(server.key, serverUri)
    // Announce before queueing: this open is about to rewrite the shared
    // document, and a request from a sibling alias is holding that queue with
    // an answer that is already doomed (#1108 review, 1). `bumpDocumentIntent`
    // could not fan out for us — this URI had no record when it ran.
    this.notifyDocumentIntent(key)
    return await this.serializeServerDocument(key, async () => {
      const existing = this.docs.get(params.clientUri)
      if (existing) {
        if (existing.serverKey !== server.key || existing.serverUri !== serverUri) {
          // One Monaco URI cannot safely represent two simultaneous server
          // documents. The visible editor will retry on its next mount;
          // mutating the old record here would let its late close tear down the
          // new one.
          return false
        }
        const shared = this.serverDocuments.get(key)
        if (!shared) return false
        existing.refs += 1
        shared.refs += 1
        await this.changeSharedDocument(server, shared, existing, params.content)
        return true
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
        if (server.closed) return false
        const created: ServerDocumentRecord = {
          key,
          serverKey: server.key,
          serverGeneration: server.generation,
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
          serverGeneration: server.generation,
          serverUri,
          serverDocumentKey: key,
          version: 1,
          language,
          refs: 1,
          content: params.content,
          completionItems: new Map(),
        })
        return true
      }

      // ── THE INVARIANT THE FENCE DEPENDS ON (#1078 review, 3) ──
      // Every document record's generation must belong to a server whose
      // `discardServer` has NOT already run — otherwise nothing will ever
      // reclaim it. Under the old key-based sweep a stale record was collected
      // by the next same-key server to die; the generation fence deliberately
      // removed that, which is the whole point, so the record must not be
      // created against a dead server in the first place.
      //
      // Branch A above checks this after its own await. This branch is
      // reachable after TWO (`getOrCreateServer`, `await server.initialized`)
      // and can then sit in the shared-URI queue behind a language-feature
      // request for up to `LSP_DOCUMENT_REQUEST_TIMEOUT_MS`, which is exactly
      // the stall #924 describes. Review could not construct a production
      // sequence that reaches here with a closed server — `connection.dispose`
      // rejects pending responses, and the rejection path is guarded — but an
      // invariant this load-bearing should not rest on that being exhaustive.
      if (server.closed) return false
      shared.refs += 1
      const doc: OpenDocumentRecord = {
        clientUri: params.clientUri,
        serverKey: server.key,
        serverGeneration: server.generation,
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
      return true
    })
  }

  /**
   * Apply the renderer's latest text. Answers whether it LANDED (#922).
   *
   * WHY a boolean and not void: every early return below means the server
   * never saw this text, and a void method reports that as success. The IPC
   * handler turns a false into a rejection, so a renderer is never told an
   * edit was delivered when it was dropped. The one thing worse than losing a
   * keystroke is losing it quietly.
   */
  async changeDocument(clientUri: string, content: string): Promise<boolean> {
    this.bumpDocumentIntent(clientUri)
    try {
      return await this.serializeDocument(clientUri, () => this.changeDocumentNow(clientUri, content))
    } finally {
      this.clearOrphanedDocumentIntent(clientUri)
    }
  }

  private async changeDocumentNow(clientUri: string, content: string): Promise<boolean> {
    const doc = this.docs.get(clientUri)
    if (!doc) return false
    return await this.serializeServerDocument(doc.serverDocumentKey, async () => {
      if (this.docs.get(clientUri) !== doc) return false
      const server = this.servers.get(doc.serverKey)
      const shared = this.serverDocuments.get(doc.serverDocumentKey)
      if (!server || !shared) return false
      await this.changeSharedDocument(server, shared, doc, content)
      return true
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

  /**
   * Track one request we walked away from, and retire a server that collects
   * too many that it NEVER answers (#924).
   *
   * WHY a request only counts once it has stayed unanswered for the full
   * request budget, not at the end of the 250 ms grace period (#1108 fix
   * pass): every keystroke abandons the request in flight, and a server that
   * is still indexing can easily be a few seconds behind. Counting at 250 ms
   * retired exactly those healthy-but-busy servers after a few seconds of
   * typing — and retiring one silently turned LSP off for the editors already
   * open. A request still unanswered `LSP_DOCUMENT_REQUEST_TIMEOUT_MS` after we
   * abandoned it is one we would have given up on even had nothing
   * superseded it, so that is the point at which it is evidence of a wedged
   * server rather than a slow one. The count still drops the moment the
   * server answers, so what trips the cap is 32 requests SIMULTANEOUSLY stuck
   * past that budget.
   *
   * `discardServer` is the same path a crash takes: documents are dropped and
   * diagnostics cleared. `lsp:change-document` then re-opens a backed
   * document on its next edit (ipc/lsp.ts), so an open editor recovers instead
   * of losing LSP until it remounts.
   */
  private noteAbandonedRequest(server: ServerRecord, settles: Promise<unknown>): void {
    let counted = false
    let answered = false
    const stuck = setTimeout(() => {
      if (answered) return
      counted = true
      server.abandonedRequests += 1
      // Deliberate, not incidental: a server this far behind is not going to
      // catch up, and every further request queues behind work it is not
      // doing.
      if (server.abandonedRequests > LSP_MAX_ABANDONED_REQUESTS && !server.closed) {
        this.discardServer(server)
      }
    }, LSP_DOCUMENT_REQUEST_TIMEOUT_MS)
    // A pending stuck-check must not keep the main process (or a test worker)
    // alive on its own; it only matters while the app is running anyway.
    stuck.unref?.()
    // `settles` is the rejection-safe wrapper, so a server that answers a
    // cancelled request with an error still counts as answering — it did,
    // which is what this counter measures.
    const onAnswer = (): void => {
      answered = true
      clearTimeout(stuck)
      if (counted) server.abandonedRequests -= 1
    }
    void settles.then(onAnswer, onAnswer)
  }

  private async sendDocRequest<T>(
    clientUri: string,
    method: string,
    extraParams: Record<string, unknown>,
    onSynchronized?: (ticket: DocRequestTicket) => void,
  ): Promise<T | null> {
    // Capture at invocation time, before joining the per-client queue. If a
    // change was invoked first, the request queues behind it with the same
    // epoch. If a change arrives later, it advances the map immediately and
    // invalidates this response even though protocol ordering makes the
    // didChange wait for the request to release the server-URI queue.
    //
    // Only `openDocument`, `changeDocument` and `closeDocument` bump intent —
    // a second REQUEST does not (#1108 review, 8). Two hovers with no edit
    // between them still serialize, because nothing about the second one makes
    // the first one's answer wrong. Intent means "the text is about to change
    // or the document is going away", not "someone else asked something".
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
          // The ticket is minted HERE — after the restore, before the request
          // leaves, so it records the revision the request was really asked
          // about.
          // WHY only the client revision (#1108 review, 6): an earlier cut
          // also carried the server version, described as "the number to
          // compare a late publishDiagnostics against". `handlePublishDiagnostics`
          // already does exactly that against `shared.version` and has no
          // ticket in scope, so the field was never read. A field nobody reads
          // is a claim nobody checks.
          onSynchronized?.({ doc: ctx.doc, clientVersion: ctx.doc.version })

          const cancellation = new CancellationTokenSource()
          let timeout: ReturnType<typeof setTimeout> | undefined
          const abandonment = this.onIntentPast(ctx.doc.serverDocumentKey, intentEpoch, clientUri)
          try {
            const pending = ctx.server.connection.sendRequest<T>(
              method,
              {
                textDocument: { uri: ctx.doc.serverUri },
                ...extraParams,
              },
              cancellation.token,
            )
            // WHY the raw `pending` is never a race entry (#1108 review, 2).
            //
            // Cancelling an LSP request does NOT reject it locally — the client
            // only sends `$/cancelRequest` and the promise still settles on the
            // server's reply. And the protocol ADVISES a server to answer a
            // cancelled request with an ERROR (`RequestCancelled`, -32800;
            // `ContentModified`, -32801 from gopls/rust-analyzer/pyright). With
            // `pending` in the race, that error became the race's result, fell
            // through the `isDestroyedStreamError`/`closed` catch, and was
            // thrown out of `getCompletions`/`getSemanticTokens`/`getHover`.
            // `provideDocumentSemanticTokens` has no catch, and semantic tokens
            // are re-requested on every model change — the request most likely
            // to be abandoned by the debounced didChange right behind it.
            //
            // So: one settled wrapper, used by every branch. A rejection is a
            // non-answer, which is exactly what it means here.
            const answered = pending.then(
              value => ({ ok: true as const, value }),
              () => ({ ok: false as const, value: undefined }),
            )
            const response = await Promise.race([
              answered,
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
              // A newer intent (#924). The response is already known to be
              // worthless — every check after this point rejects it — so the
              // only thing still waiting on it is the user's next keystroke.
              // Cancel, give the server a short grace period to answer anyway,
              // then let go of both queues.
              abandonment.promise.then(async (): Promise<typeof LSP_REQUEST_TIMED_OUT> => {
                cancellation.cancel()
                // WHY the grace period does not use `timeout`'s `finally`
                // cleanup path (#1108 review, 5): if the first intent bump
                // lands inside the last 250 ms of the 15 s budget, the timeout
                // branch settles the outer race, the `finally` clears this
                // timer, and this closure is left awaiting a promise that
                // never settles — retaining `ctx.doc`, `ctx.server` and `this`
                // for the process lifetime, AND never counting the abandonment
                // that most deserved counting. The timer is cleared locally, on
                // every exit from this branch, instead.
                let graceTimer: ReturnType<typeof setTimeout> | undefined
                try {
                  const settled = await Promise.race([
                    answered.then(() => true),
                    new Promise<false>(resolveGrace => {
                      graceTimer = setTimeout(() => resolveGrace(false), LSP_ABANDONED_REQUEST_GRACE_MS)
                    }),
                  ])
                  // `settled` only distinguishes a server that answered from
                  // one that did not, for the bound below; either way this
                  // request is over as far as we are concerned.
                  if (!settled) this.noteAbandonedRequest(ctx.server, answered)
                } finally {
                  if (graceTimer) clearTimeout(graceTimer)
                }
                return LSP_REQUEST_TIMED_OUT
              }),
            ])
            if (response === LSP_REQUEST_TIMED_OUT) return null
            // A rejection reached us as a non-answer rather than as a throw.
            if (!response.ok) return null
            if (
              this.docs.get(clientUri) !== ctx.doc ||
              (this.documentIntentEpochs.get(clientUri) ?? 0) !== intentEpoch
            ) {
              return null
            }
            return response.value
          } catch (err) {
            if (isDestroyedStreamError(err) || ctx.server.closed) return null
            throw err
          } finally {
            if (timeout) clearTimeout(timeout)
            abandonment.cancel()
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
    if (!this.docs.has(clientUri)) return { items: [], incomplete: false }
    // Minted inside the request, after it restored this alias's draft (#923).
    // Comparing against a version read out here instead is what made every
    // completion from the inactive half of a split view come back empty: the
    // restore advances the version, so the pre-request number could never
    // match. Absent means the request never reached the synchronization step
    // (no document, no server, a superseding intent) and there is nothing to
    // validate.
    let ticket: DocRequestTicket | undefined
    const result = await this.sendDocRequest<CompletionItem[] | CompletionList | null>(
      clientUri,
      'textDocument/completion',
      { position, context },
      issued => { ticket = issued },
    )
    const doc = this.docs.get(clientUri)
    // Cancellation is advisory and can race a server response. Keep this
    // version proof as a second boundary: if the user typed while the server
    // was answering, never repopulate resolve handles for the older text.
    if (!ticket || !doc || doc !== ticket.doc || doc.version !== ticket.clientVersion || !result) {
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
    // Wake every alias of the same server document, not just this URI — see
    // the field's header. A URI with no record yet (an open still resolving
    // its server) has no shared key to fan out on; `openDocumentNow` notifies
    // explicitly once it knows the key.
    const serverDocumentKey = this.docs.get(clientUri)?.serverDocumentKey
    if (serverDocumentKey) this.notifyDocumentIntent(serverDocumentKey)
    return next
  }

  private notifyDocumentIntent(serverDocumentKey: string): void {
    // Copy before notifying: a woken waiter removes itself, and mutating the
    // set we are iterating is how that becomes an intermittent skip.
    const waiters = this.documentIntentWaiters.get(serverDocumentKey)
    if (waiters) for (const wake of [...waiters]) wake()
  }

  /**
   * Resolve when anyone intends to touch this server document, or never.
   *
   * `clientUri` and `epoch` are used only for the already-moved check at
   * subscription time: the epoch can advance between the caller reading it and
   * this subscription existing, and a listener that only looks forward would
   * sleep through that bump and hold both queues for the full timeout.
   *
   * Returns its own unsubscribe rather than taking an AbortSignal because the
   * only caller is a `Promise.race` that must not leak a listener on the two
   * branches it loses.
   */
  private onIntentPast(
    serverDocumentKey: string,
    epoch: number,
    clientUri: string,
  ): { promise: Promise<void>; cancel: () => void } {
    let wake!: () => void
    const promise = new Promise<void>(resolve => { wake = resolve })
    const waiters = this.documentIntentWaiters.get(serverDocumentKey) ?? new Set<() => void>()
    waiters.add(wake)
    this.documentIntentWaiters.set(serverDocumentKey, waiters)
    const cancel = (): void => {
      waiters.delete(wake)
      // Only drop the set if it is still OURS: a replacement set with a live
      // waiter in it must not be deleted by a late cancel (#1108 review, 9).
      if (waiters.size === 0 && this.documentIntentWaiters.get(serverDocumentKey) === waiters) {
        this.documentIntentWaiters.delete(serverDocumentKey)
      }
    }
    if ((this.documentIntentEpochs.get(clientUri) ?? 0) !== epoch) wake()
    return { promise, cancel }
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
        // `record`, not `this.servers.get(key)` (#1078 review, 4). The key is
        // reused by a replacement, so the lookup could hand `initialized` to a
        // DIFFERENT server process than the one that just initialised — and
        // `sendNotificationIfOpen` already refuses a closed record, so this is
        // both more correct and no less safe.
        void this.sendNotificationIfOpen(record, 'initialized', {})
      })
      .catch(() => {})

    const legendPromise = initialized
      .then(result => result.capabilities.semanticTokensProvider?.legend ?? null)
      .catch(() => null)

    const record: ServerRecord = {
      key,
      generation: nextServerGeneration(),
      specId: spec.id,
      workspaceRoot: rootAbs,
      process: child,
      connection,
      initialized,
      legendPromise,
      closed: false,
      abandonedRequests: 0,
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
    // THIS server's own resources are always disposed. It is dead either way,
    // and leaving its connection or process around is a leak regardless of who
    // currently holds its key.
    if (!server.closed) {
      server.closed = true
      try {
        server.connection.dispose()
      } catch {
        // A spawn/initialize failure can tear streams down first.
      }
      if (kill && !server.process.killed) server.process.kill()
    }
    // ── SHARED RECORDS ARE FENCED ON THE GENERATION, NOT THE KEY (#921) ──
    // `key` comes from the language spec plus the workspace root, so a
    // replacement server spawned after a crash REUSES it. The registry
    // deletion above already knew that and compared object identity — but
    // these two loops matched on `key`, so a SECOND `discardServer` for an
    // already-discarded server deleted the REPLACEMENT's documents.
    //
    // Being precise about when that happens, because the first version of this
    // comment was not (#1078 review, 6): the FIRST discard is never late — it
    // is what removes the server from the registry and lets a replacement be
    // created. The danger is a second call for the same record afterwards, and
    // `process.on('exit')` is the one that reliably arrives that way: `error`
    // and a rejected `initialized` both discard synchronously enough to be the
    // first, but `exit` fires whenever the child finally dies, which can be
    // long after a replacement is serving.
    //
    // What that looks like: the editor is attached to a healthy new server,
    // and its documents vanish from `docs`/`serverDocuments` with diagnostics
    // cleared, while the server still holds them open. Nothing re-opens them
    // until the editor remounts, so completions and diagnostics stop for a
    // file that is on screen and fine.
    for (const doc of [...this.docs.values()]) {
      if (doc.serverGeneration !== server.generation) continue
      this.docs.delete(doc.clientUri)
      this.documentIntentEpochs.delete(doc.clientUri)
      this.emit('diagnostics', { clientUri: doc.clientUri, diagnostics: [] })
    }
    for (const [key, doc] of this.serverDocuments) {
      if (doc.serverGeneration === server.generation) this.serverDocuments.delete(key)
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
