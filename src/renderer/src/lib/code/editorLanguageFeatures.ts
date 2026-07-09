import type * as Monaco from 'monaco-editor'

import {
  monacoLanguageId,
  normalizeCodeLanguage,
  supportsLsp,
} from '@shared/code/language'
import type { LspCompletionItem } from '@shared/types/lsp'
import { openFileInGlobalEditor } from '@renderer/features/global-editor/openFileInGlobalEditor'
import { useGlobalEditorStore } from '@renderer/features/global-editor/store'

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
// WHY this lives in lib/code but imports from features/global-editor:
// the editor OPENER (cross-file go-to-definition) must route through the
// Global Editor's open-file path to inherit its root-containment and tab
// semantics. This is a deliberate upward dependency, mirrored on
// rendered-content's SafeMarkdownLink; if a second editor host ever
// needs different routing, lift the opener callback into a registration
// parameter instead of forking this module.

const registeredMonacoLanguages = new Set<string>()
let openerInstalled = false

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

function toLspPosition(position: Monaco.Position): { line: number; character: number } {
  // Monaco is 1-based, LSP is 0-based. An off-by-one here silently
  // degrades every feature (hover misses, definitions land one line off),
  // so the conversion lives in exactly one function.
  return { line: position.lineNumber - 1, character: position.column - 1 }
}

function toMonacoRange(
  monaco: typeof Monaco,
  loc: { startLine: number; startCharacter: number; endLine: number; endCharacter: number },
): Monaco.Range {
  return new monaco.Range(
    loc.startLine + 1,
    loc.startCharacter + 1,
    loc.endLine + 1,
    loc.endCharacter + 1,
  )
}

export function ensureEditorLanguageFeatures(monaco: typeof Monaco, language: string): void {
  installEditorOpener(monaco)
  const normalized = normalizeCodeLanguage(language)
  if (!supportsLsp(normalized)) return
  const monacoId = monacoLanguageId(normalized)
  if (registeredMonacoLanguages.has(monacoId)) return
  registeredMonacoLanguages.add(monacoId)

  monaco.languages.registerHoverProvider(monacoId, {
    async provideHover(model, position) {
      const result = await window.api.getLspHover(
        model.uri.toString(),
        toLspPosition(position),
      )
      if (!result) return null
      return { contents: [{ value: result.markdown }] }
    },
  })

  monaco.languages.registerDefinitionProvider(monacoId, {
    async provideDefinition(model, position) {
      const locations = await window.api.getLspDefinition(
        model.uri.toString(),
        toLspPosition(position),
      )
      return locations.map(loc => ({
        uri: monaco.Uri.file(loc.absolutePath),
        range: toMonacoRange(monaco, loc),
      }))
    },
  })

  monaco.languages.registerReferenceProvider(monacoId, {
    async provideReferences(model, position) {
      const locations = await window.api.getLspReferences(
        model.uri.toString(),
        toLspPosition(position),
      )
      return locations.map(loc => ({
        uri: monaco.Uri.file(loc.absolutePath),
        range: toMonacoRange(monaco, loc),
      }))
    },
  })

  monaco.languages.registerCompletionItemProvider(monacoId, {
    triggerCharacters: ['.', '"', "'", '/', '@', '<'],
    async provideCompletionItems(model, position) {
      const items = await window.api.getLspCompletions(
        model.uri.toString(),
        toLspPosition(position),
      )
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
        suggestions: items.map((item: LspCompletionItem) => ({
          label: item.label,
          kind: completionKindToMonaco(monaco, item.kind),
          insertText: item.insertText,
          insertTextRules: item.isSnippet
            ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
            : undefined,
          detail: item.detail,
          documentation: item.documentation ? { value: item.documentation } : undefined,
          sortText: item.sortText,
          range,
        })),
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
    openCodeEditor(_source, resource, selectionOrPosition) {
      if (resource.scheme !== 'file') return false
      const { activeCwd } = useGlobalEditorStore.getState()
      if (!activeCwd) return false
      const rootAbs = activeCwd.replace(/\/+$/, '')
      if (!resource.path.startsWith(`${rootAbs}/`)) return false
      const relative = resource.path.slice(rootAbs.length + 1)
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
      void openFileInGlobalEditor({ root: activeCwd, path: relative, line, column })
      return true
    },
  })
}
