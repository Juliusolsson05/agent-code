import type * as Monaco from 'monaco-editor'

import { monacoLanguageId, normalizeCodeLanguage, supportsLsp } from '@shared/code/language'
import type { LspCompletionItem, LspCompletionTextEdit, LspDocumentSymbol } from '@shared/types/lsp'

// Monaco↔LSP feature providers for the FILE EDITOR surface (#513).
//
// WHY these are registered per-language globally (Monaco has no
// per-editor providers) but fail open per-model: providers key off
// model.uri, and main's LspManager only answers for uris that went
// through openLspDocument. Transcript CodeBlocks share the same Monaco
// languages but their editors disable hover and are readOnly (no
// completion trigger), and their synthetic cc-shell:// uris resolve to
// LSP docs too — so the providers are inert-or-consistent there by
// construction rather than by special-casing.
//
// WHY navigation is registered per model instead of importing one global
// editor store: Monaco providers/openers are process-global, while Global
// Editor and AI Workspace have intentionally different file capabilities.
// Keeping the host callback beside the model URI prevents focus changes from
// routing a result through the wrong workspace and avoids an upward feature
// dependency from this shared Monaco layer.

const registeredMonacoLanguages = new Set<string>()
let openerInstalled = false
type ModelContext = {
  workspaceRoot: string
  openDefinition: (absolutePath: string, line: number, column: number) => Promise<boolean>
  refs: number
  syncedVersion: number | null
  pendingSync: { version: number; promise: Promise<boolean> } | null
}
const modelContexts = new Map<string, ModelContext>()

/** Bind a Monaco model to the filesystem root that authorized its LSP doc.
 * Global providers cannot infer this from the currently focused agent: AI
 * Workspaces deliberately edit files from other worktrees. */
export function registerEditorLspContext(
  clientUri: string,
  context: Pick<ModelContext, 'workspaceRoot' | 'openDefinition'>,
): () => void {
  const existing = modelContexts.get(clientUri)
  if (existing && existing.workspaceRoot === context.workspaceRoot) {
    existing.refs += 1
    existing.openDefinition = context.openDefinition
  } else {
    modelContexts.set(clientUri, {
      ...context,
      refs: 1,
      syncedVersion: null,
      pendingSync: null,
    })
  }
  return () => {
    const current = modelContexts.get(clientUri)
    if (!current || current.workspaceRoot !== context.workspaceRoot) return
    current.refs -= 1
    if (current.refs <= 0) modelContexts.delete(clientUri)
  }
}

/** Record the exact Monaco version used for didOpen. Registration happens only
 * after main acknowledges open, so providers cannot "successfully" sync an
 * unowned URI during a slow server startup. */
export function markEditorLspModelSynced(clientUri: string, version: number): void {
  const context = modelContexts.get(clientUri)
  if (context) context.syncedVersion = version
}

export async function syncEditorLspModel(model: Monaco.editor.ITextModel): Promise<boolean> {
  const clientUri = model.uri.toString()
  const context = modelContexts.get(clientUri)
  if (!context) return false
  const version = model.getVersionId()
  if (context.syncedVersion === version) return true
  if (context.pendingSync?.version === version) return await context.pendingSync.promise

  // LSP positions describe Monaco's editable text, which excludes its hidden
  // BOM. Sending preserveBOM=true would shift every first-line server position
  // by one even though source-save fidelity correctly retains the marker.
  const content = model.getValue()
  const prior = context.pendingSync?.promise ?? Promise.resolve(true)
  const promise = prior
    .catch(() => false)
    .then(async () => {
      const current = modelContexts.get(clientUri)
      if (current !== context) return false
      if (current.syncedVersion === version) return true
      try {
        // The typing path and hover/definition/completion providers all call
        // this one coalescing gate. A Monaco version crosses IPC at most once,
        // while an explicit feature still waits for the exact current text.
        await window.api.changeLspDocument(clientUri, content)
        if (modelContexts.get(clientUri) !== context) return false
        context.syncedVersion = version
        return true
      } catch {
        return false
      }
    })
  context.pendingSync = { version, promise }
  void promise.finally(() => {
    if (context.pendingSync?.promise === promise) context.pendingSync = null
  })
  return await promise
}

// LSP CompletionItemKind (1-based) → Monaco CompletionItemKind. The two
// enums are DIFFERENT integer spaces — passing LSP kinds straight through
// renders wrong icons (e.g. LSP Function=3 vs Monaco Function=1).
function completionKindToMonaco(
  monaco: typeof Monaco,
  kind: number,
): Monaco.languages.CompletionItemKind {
  const K = monaco.languages.CompletionItemKind
  const map: Record<number, Monaco.languages.CompletionItemKind> = {
    1: K.Text,
    2: K.Method,
    3: K.Function,
    4: K.Constructor,
    5: K.Field,
    6: K.Variable,
    7: K.Class,
    8: K.Interface,
    9: K.Module,
    10: K.Property,
    11: K.Unit,
    12: K.Value,
    13: K.Enum,
    14: K.Keyword,
    15: K.Snippet,
    16: K.Color,
    17: K.File,
    18: K.Reference,
    19: K.Folder,
    20: K.EnumMember,
    21: K.Constant,
    22: K.Struct,
    23: K.Event,
    24: K.Operator,
    25: K.TypeParameter,
  }
  return map[kind] ?? K.Text
}

function toLspPosition(position: Monaco.Position): {
  line: number
  character: number
} {
  // Monaco is 1-based, LSP is 0-based. An off-by-one here silently
  // degrades every feature (hover misses, definitions land one line off),
  // so the conversion lives in exactly one function.
  return { line: position.lineNumber - 1, character: position.column - 1 }
}

function toMonacoRange(
  monaco: typeof Monaco,
  loc: {
    startLine: number
    startCharacter: number
    endLine: number
    endCharacter: number
  },
): Monaco.Range {
  return new monaco.Range(
    loc.startLine + 1,
    loc.startCharacter + 1,
    loc.endLine + 1,
    loc.endCharacter + 1,
  )
}

function completionEditToMonaco(
  monaco: typeof Monaco,
  edit: LspCompletionTextEdit,
): { range: Monaco.Range; text: string } {
  return {
    range: toMonacoRange(monaco, edit),
    text: edit.newText,
  }
}

function documentSymbolToMonaco(
  monaco: typeof Monaco,
  symbol: LspDocumentSymbol,
): Monaco.languages.DocumentSymbol {
  const minimumKind = monaco.languages.SymbolKind.File
  const maximumKind = monaco.languages.SymbolKind.TypeParameter
  // LSP SymbolKind and Monaco SymbolKind intentionally have the same ordering,
  // but LSP starts at 1 while Monaco starts at 0. Passing the wire number
  // directly makes every outline icon one category off and turns TypeParameter
  // into an out-of-range enum value.
  const kind = Math.min(maximumKind, Math.max(minimumKind, symbol.kind - 1))
  const range = toMonacoRange(monaco, symbol)
  const selectionRange = toMonacoRange(monaco, {
    startLine: symbol.selectionStartLine,
    startCharacter: symbol.selectionStartCharacter,
    endLine: symbol.selectionEndLine,
    endCharacter: symbol.selectionEndCharacter,
  })
  return {
    name: symbol.name,
    detail: '',
    kind,
    tags: [],
    range,
    selectionRange,
    children: symbol.children.map(child => documentSymbolToMonaco(monaco, child)),
  }
}

type ResolvableCompletionItem = Monaco.languages.CompletionItem & {
  lspClientUri?: string
  lspResolveId?: number
}

export function ensureEditorLanguageFeatures(monaco: typeof Monaco, language: string): void {
  installEditorOpener(monaco)
  const normalized = normalizeCodeLanguage(language)
  if (!supportsLsp(normalized)) return
  const monacoId = monacoLanguageId(normalized)
  if (registeredMonacoLanguages.has(monacoId)) return
  registeredMonacoLanguages.add(monacoId)

  monaco.languages.registerHoverProvider(monacoId, {
    async provideHover(model, position, token) {
      if (!(await syncEditorLspModel(model)) || token.isCancellationRequested) return null
      const result = await window.api
        .getLspHover(model.uri.toString(), toLspPosition(position))
        .catch(() => null)
      if (!result || token.isCancellationRequested) return null
      return { contents: [{ value: result.markdown }] }
    },
  })

  monaco.languages.registerDefinitionProvider(monacoId, {
    async provideDefinition(model, position, token) {
      if (!(await syncEditorLspModel(model)) || token.isCancellationRequested) return []
      const locations = await window.api
        .getLspDefinition(model.uri.toString(), toLspPosition(position))
        .catch(() => [])
      if (token.isCancellationRequested) return []
      return locations.map(loc => ({
        uri: monaco.Uri.file(loc.absolutePath),
        range: toMonacoRange(monaco, loc),
      }))
    },
  })

  monaco.languages.registerReferenceProvider(monacoId, {
    async provideReferences(model, position, _context, token) {
      if (!(await syncEditorLspModel(model)) || token.isCancellationRequested) return []
      const locations = await window.api
        .getLspReferences(model.uri.toString(), toLspPosition(position))
        .catch(() => [])
      if (token.isCancellationRequested) return []
      return locations.map(loc => ({
        uri: monaco.Uri.file(loc.absolutePath),
        range: toMonacoRange(monaco, loc),
      }))
    },
  })

  monaco.languages.registerDocumentSymbolProvider(monacoId, {
    displayName: 'Language Server',
    async provideDocumentSymbols(model, token) {
      if (!(await syncEditorLspModel(model)) || token.isCancellationRequested) return []
      const symbols = await window.api.getLspDocumentSymbols(model.uri.toString()).catch(() => [])
      if (token.isCancellationRequested) return []
      return symbols.map(symbol => documentSymbolToMonaco(monaco, symbol))
    },
  })

  monaco.languages.registerCompletionItemProvider(monacoId, {
    triggerCharacters: ['.', '"', "'", '/', '@', '<'],
    async provideCompletionItems(model, position, context, token) {
      if (!(await syncEditorLspModel(model)) || token.isCancellationRequested) {
        return { suggestions: [] }
      }
      const result = await window.api
        .getLspCompletions(model.uri.toString(), toLspPosition(position), {
          // Monaco and LSP encode the same three states with Monaco zero-based
          // and LSP one-based enums. Passing the real trigger is important for
          // servers that return a deliberately incomplete first list.
          triggerKind: (context.triggerKind + 1) as 1 | 2 | 3,
          ...(context.triggerCharacter ? { triggerCharacter: context.triggerCharacter } : {}),
        })
        .catch(() => ({ items: [], incomplete: false }))
      if (token.isCancellationRequested) return { suggestions: [] }
      const word = model.getWordUntilPosition(position)
      // Replace the word being typed. LSP servers CAN send precise
      // textEdit ranges per item, but tsserver's default suggestions are
      // word-scoped, and Monaco's word-until-position matches what the
      // user sees being completed — good enough until a server that
      // needs textEdit fidelity shows up.
      const range = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn,
      )
      return {
        incomplete: result.incomplete,
        suggestions: result.items.map((item: LspCompletionItem) => {
          const itemRange = item.textEdit
            ? new monaco.Range(
                item.textEdit.startLine + 1,
                item.textEdit.startCharacter + 1,
                item.textEdit.endLine + 1,
                item.textEdit.endCharacter + 1,
              )
            : range
          return {
            label: item.label,
            kind: completionKindToMonaco(monaco, item.kind),
            insertText: item.textEdit?.newText ?? item.insertText,
            insertTextRules: item.isSnippet
              ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
              : undefined,
            detail: item.detail,
            documentation: item.documentation ? { value: item.documentation } : undefined,
            sortText: item.sortText,
            range: itemRange,
            additionalTextEdits: item.additionalTextEdits?.map(edit =>
              completionEditToMonaco(monaco, edit),
            ),
            lspClientUri: model.uri.toString(),
            lspResolveId: item.resolveId,
          }
        }),
      }
    },
    async resolveCompletionItem(item, token) {
      const unresolved = item as ResolvableCompletionItem
      if (
        token.isCancellationRequested ||
        !unresolved.lspClientUri ||
        unresolved.lspResolveId == null
      ) {
        return item
      }
      const resolved = await window.api
        .resolveLspCompletion(unresolved.lspClientUri, unresolved.lspResolveId)
        .catch(() => null)
      if (!resolved || token.isCancellationRequested) return item
      // Servers commonly defer auto-import edits and documentation until
      // resolution. Preserve Monaco's original range when the server does not
      // replace it, but accept a resolved primary edit when it does.
      return {
        ...item,
        insertText: resolved.textEdit?.newText ?? resolved.insertText ?? item.insertText,
        insertTextRules: resolved.isSnippet
          ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
          : item.insertTextRules,
        range: resolved.textEdit
          ? completionEditToMonaco(monaco, resolved.textEdit).range
          : item.range,
        detail: resolved.detail ?? item.detail,
        documentation: resolved.documentation
          ? { value: resolved.documentation }
          : item.documentation,
        additionalTextEdits: resolved.additionalTextEdits
          ? resolved.additionalTextEdits.map(edit => completionEditToMonaco(monaco, edit))
          : item.additionalTextEdits,
      }
    },
  })
}

// Cross-file go-to-definition. Standalone Monaco can't open other files —
// its default behavior on a foreign-uri definition is a no-op.
// registerEditorOpener is the standalone escape hatch: Monaco calls it
// with the target resource + selection and we route through
// openFileInGlobalEditor, which enforces root containment in main.
// Definitions OUTSIDE the active cwd (a .d.ts under some other root,
// system libs) are rejected by that containment — we deliberately fail
// closed there rather than growing an OS-level "open anything" hole.
function installEditorOpener(monaco: typeof Monaco): void {
  if (openerInstalled) return
  openerInstalled = true
  monaco.editor.registerEditorOpener({
    async openCodeEditor(source, resource, selectionOrPosition) {
      if (resource.scheme !== 'file') return false
      const sourceUri = source?.getModel()?.uri.toString()
      const context = sourceUri ? modelContexts.get(sourceUri) : null
      if (!context) return false
      let line = 1
      let column = 1
      if (selectionOrPosition) {
        if ('startLineNumber' in selectionOrPosition) {
          line = selectionOrPosition.startLineNumber
          column = selectionOrPosition.startColumn
        } else {
          line = selectionOrPosition.lineNumber
          column = selectionOrPosition.column
        }
      }
      // Each editor host owns its navigation semantics. Global Editor may open
      // any contained project file; AI Workspace may open only another curated
      // entry. Keeping that callback beside the authorized model context avoids
      // turning a definition result into generic filesystem authority.
      return await context.openDefinition(resource.fsPath, line, column)
    },
  })
}
