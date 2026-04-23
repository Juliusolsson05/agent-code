import { EventEmitter } from 'events'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createRequire } from 'module'
import { resolve } from 'path'
import { pathToFileURL } from 'url'

import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node.js'
import {
  DiagnosticSeverity,
  type InitializeParams,
  type InitializeResult,
  type PublishDiagnosticsParams,
  type SemanticTokens,
  type SemanticTokensLegend,
} from 'vscode-languageserver-protocol'

import {
  languageFileExtension,
  supportsLsp,
} from '@shared/code/language.js'

const require = createRequire(import.meta.url)

type SupportedLanguage =
  | 'javascript'
  | 'javascriptreact'
  | 'typescript'
  | 'typescriptreact'

export type LspDiagnostic = {
  message: string
  severity: 'error' | 'warning' | 'info' | 'hint'
  startLine: number
  startCharacter: number
  endLine: number
  endCharacter: number
}

export type LspDiagnosticsEvent = {
  clientUri: string
  diagnostics: LspDiagnostic[]
}

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
  language: SupportedLanguage
}

type ServerRecord = {
  key: string
  workspaceRoot: string
  process: ChildProcessWithoutNullStreams
  connection: MessageConnection
  initialized: Promise<InitializeResult>
  legendPromise: Promise<SemanticTokensLegend | null>
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

function normalizeSupportedLanguage(language: string): SupportedLanguage | null {
  if (language === 'javascript') return 'javascript'
  if (language === 'javascriptreact') return 'javascriptreact'
  if (language === 'typescript') return 'typescript'
  if (language === 'typescriptreact') return 'typescriptreact'
  return null
}

function makeVirtualServerUri(
  workspaceRoot: string,
  clientUri: string,
  language: SupportedLanguage,
): string {
  const ext = languageFileExtension(language)
  const filePath = resolve(
    workspaceRoot,
    '.cc-shell-lsp',
    `virtual-${hashText(clientUri)}.${ext}`,
  )
  return pathToFileURL(filePath).href
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
  emit<K extends keyof LspManagerEvents>(
    event: K,
    ...args: LspManagerEvents[K]
  ): boolean
}

export class LspManager extends EventEmitter {
  private readonly servers = new Map<string, ServerRecord>()
  private readonly docs = new Map<string, OpenDocumentRecord>()

  async ensureSemanticLegend(
    workspaceRoot: string,
    language: string,
  ): Promise<SemanticTokensLegend | null> {
    if (!supportsLsp(language)) return null
    const server = this.getOrCreateServer(workspaceRoot)
    return await server.legendPromise
  }

  async openDocument(params: OpenDocumentParams): Promise<void> {
    if (!supportsLsp(params.language)) return
    const language = normalizeSupportedLanguage(params.language)
    if (!language) return
    const workspaceRoot = params.workspaceRoot || process.cwd()
    const server = this.getOrCreateServer(workspaceRoot)
    await server.initialized

    const serverUri = params.filePath
      ? pathToFileURL(resolve(workspaceRoot, params.filePath)).href
      : makeVirtualServerUri(workspaceRoot, params.clientUri, language)
    const existing = this.docs.get(params.clientUri)
    if (existing) {
      await this.changeDocument(params.clientUri, params.content)
      return
    }

    server.connection.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri: serverUri,
        languageId: language,
        version: 1,
        text: params.content,
      },
    })

    this.docs.set(params.clientUri, {
      clientUri: params.clientUri,
      serverKey: server.key,
      serverUri,
      version: 1,
      language,
    })
  }

  async changeDocument(clientUri: string, content: string): Promise<void> {
    const doc = this.docs.get(clientUri)
    if (!doc) return
    const server = this.servers.get(doc.serverKey)
    if (!server) return
    doc.version += 1
    server.connection.sendNotification('textDocument/didChange', {
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
    const server = this.servers.get(doc.serverKey)
    if (server) {
      server.connection.sendNotification('textDocument/didClose', {
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
    return await server.connection.sendRequest('textDocument/semanticTokens/full', {
      textDocument: { uri: doc.serverUri },
    })
  }

  async dispose(): Promise<void> {
    for (const clientUri of this.docs.keys()) {
      await this.closeDocument(clientUri)
    }
    for (const server of this.servers.values()) {
      server.connection.dispose()
      server.process.kill()
    }
    this.servers.clear()
  }

  private getOrCreateServer(workspaceRoot: string): ServerRecord {
    const key = resolve(workspaceRoot)
    const existing = this.servers.get(key)
    if (existing) return existing

    const cliPath = require.resolve('typescript-language-server/lib/cli.mjs')
    const child = spawn(process.execPath, [cliPath, '--stdio'], {
      cwd: workspaceRoot,
      stdio: 'pipe',
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
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
      rootUri: pathToFileURL(key).href,
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
        },
        workspace: {
          configuration: false,
        },
      },
      workspaceFolders: [
        {
          uri: pathToFileURL(key).href,
          name: key.split('/').pop() ?? key,
        },
      ],
    }

    const initialized = connection.sendRequest(
      'initialize',
      initializeParams,
    ) as Promise<InitializeResult>
    initialized
      .then(() => {
        connection.sendNotification('initialized', {})
      })
      .catch(() => {})

    const legendPromise = initialized.then(result => {
      return result.capabilities.semanticTokensProvider?.legend ?? null
    })

    const record: ServerRecord = {
      key,
      workspaceRoot: key,
      process: child,
      connection,
      initialized,
      legendPromise,
    }

    child.on('exit', () => {
      this.servers.delete(key)
      for (const doc of [...this.docs.values()]) {
        if (doc.serverKey !== key) continue
        this.docs.delete(doc.clientUri)
        this.emit('diagnostics', { clientUri: doc.clientUri, diagnostics: [] })
      }
    })

    this.servers.set(key, record)
    return record
  }
}
