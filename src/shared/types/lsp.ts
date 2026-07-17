// LSP IPC payload contracts.
//
// WHY shared: `LspManager` (main) produces diagnostics + the semantic-token
// legend, preload bridges them, and Monaco-backed code blocks in the renderer
// consume them. The shapes were declared twice (main `lspManager.ts` and
// preload `api/types.ts`); a severity-union or field change on one side could
// silently diverge. One definition closes that gap.
//
// INVARIANT: the severity union stays exactly 'error' | 'warning' | 'info' |
// 'hint' — Monaco maps each to a marker severity. Adding a value here without
// updating the renderer's marker mapping would render an unknown severity.

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

/** Token type/modifier legend returned by `lsp:ensure-legend`; the renderer
 *  needs it to decode the flat semantic-tokens int array Monaco receives. */
export type LspSemanticLegend = {
  tokenTypes: string[]
  tokenModifiers: string[]
}

/** Main-process proof used when opening/bootstrapping an LSP document. Project
 * editors are authorized through their session-root capability; AI Workspace
 * editors name a main-owned curated entry instead of laundering its project
 * root into the generic editor filesystem API. */
export type LspDocumentAuthorization =
  { kind: 'editor-root' } | { kind: 'ai-workspace'; workspaceId: string; entryId: string }

// ── Request/response shapes for editor language features ─────────────────
//
// WHY raw-LSP-shaped (0-based positions, numeric kind enums) instead of
// Monaco-shaped: main must stay Monaco-free (it has no Monaco at all), and
// the renderer already owns a Monaco mapping layer
// (editorLanguageFeatures.ts) where the 1-based conversion and kind-enum
// translation live in ONE place. Shipping Monaco shapes over IPC would
// smear that mapping across both processes.

/** 0-based, LSP convention. Monaco is 1-based — convert at the boundary. */
export type LspPosition = { line: number; character: number }

export type LspLocation = {
  absolutePath: string
  startLine: number
  startCharacter: number
  endLine: number
  endCharacter: number
}

export type LspHoverResult = { markdown: string } | null

export type LspCompletionTextEdit = {
  newText: string
  startLine: number
  startCharacter: number
  endLine: number
  endCharacter: number
}

export type LspCompletionContext = {
  /** LSP CompletionTriggerKind (1=invoked, 2=character, 3=incomplete). */
  triggerKind: 1 | 2 | 3
  triggerCharacter?: string
}

export type LspCompletionItem = {
  label: string
  /** Raw LSP CompletionItemKind (1-based enum); renderer maps to Monaco's
   *  DIFFERENT integer space. */
  kind: number
  insertText: string
  textEdit?: LspCompletionTextEdit
  /** Opaque, document-scoped handle for completionItem/resolve. Raw server
   * data stays in main so renderer code cannot forge arbitrary protocol
   * payloads or retain them after the document changes. */
  resolveId?: number
  additionalTextEdits?: LspCompletionTextEdit[]
  detail?: string
  documentation?: string
  sortText?: string
  /** LSP InsertTextFormat.Snippet — Monaco needs the InsertAsSnippet rule
   *  flag or `$0` placeholders render literally. */
  isSnippet: boolean
}

export type LspCompletionResult = {
  items: LspCompletionItem[]
  /** Monaco uses this to ask again after the user narrows an intentionally
   * incomplete server result instead of filtering a partial list forever. */
  incomplete: boolean
}

export type LspDocumentSymbol = {
  name: string
  /** Raw LSP SymbolKind. */
  kind: number
  startLine: number
  startCharacter: number
  endLine: number
  endCharacter: number
  children: LspDocumentSymbol[]
}
