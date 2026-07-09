import { useEffect, useRef } from 'react'
import type * as Monaco from 'monaco-editor'

import { monacoLanguageId, supportsLsp } from '@shared/code/language'
import { ensureSemanticProvider, getMonaco } from '@renderer/lib/code/monacoRuntime'
import { ensureEditorLanguageFeatures } from '@renderer/lib/code/editorLanguageFeatures'
import {
  acquireEditorModel,
  releaseEditorModel,
} from '@renderer/features/editor/lib/editorModelRegistry'
import {
  activateEditorTheme,
  deactivateEditorTheme,
} from '@renderer/features/editor/lib/monacoEditorTheme'
import type { EditorFileBuffer } from '@renderer/features/editor/types'

type Props = {
  file: EditorFileBuffer | null
  projectRoot: string | null
  onChange: (path: string, text: string) => void
  onSave: () => void
  onSelectionRevealed?: (path: string) => void
}

export function MonacoFileEditor({
  file,
  projectRoot,
  onChange,
  onSave,
  onSelectionRevealed,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container || !file || !projectRoot) return
    let disposed = false
    let editor: Monaco.editor.IStandaloneCodeEditor | null = null
    let model: Monaco.editor.ITextModel | null = null
    // Collect ALL cleanup functions as they're created — even inside the
    // async block. The effect cleanup runs them all (LIFO), regardless of
    // how far the async init got before unmount. Same pattern (and WHY)
    // as CodeBlock's Monaco effect: cleanups captured in locals that the
    // cleanup closure can't reach when the async hasn't finished yet are
    // exactly how the MaxListenersExceeded IPC leak happened there.
    const cleanups: Array<() => void> = []

    void (async () => {
      const monaco = await getMonaco()
      if (disposed) return
      // Register and switch to the editor-mode theme before creating the
      // instance so the first paint already uses the canvas background
      // instead of flashing the darker code-slab theme. See
      // monacoEditorTheme.ts for the global-theme trade-off.
      activateEditorTheme(monaco)
      cleanups.push(() => deactivateEditorTheme(monaco))
      // monacoLanguageId: buffers carry LSP-facing ids ('typescriptreact');
      // Monaco only knows 'typescript'/'javascript' — see language.ts.
      // Acquired (not created) so the model — and with it the undo stack —
      // survives tab switches; see editorModelRegistry's ownership
      // contract.
      model = acquireEditorModel(monaco, {
        absolutePath: file.absolutePath,
        text: file.currentText,
        monacoLangId: monacoLanguageId(file.language),
      })
      // Viewer role only: release the refcount on unmount, never dispose.
      // The model must outlive this component so the undo stack survives
      // tab switches; disposal happens on actual tab close via
      // disposeEditorModel — see editorModelRegistry's ownership contract.
      const acquiredModelPath = file.absolutePath
      cleanups.push(() => releaseEditorModel(acquiredModelPath))
      editor = monaco.editor.create(container, {
        model,
        readOnly: false,
        minimap: { enabled: true, renderCharacters: false, maxColumn: 100 },
        fontFamily: '"JetBrains Mono", ui-monospace, Menlo, Monaco, monospace',
        fontSize: 13,
        lineHeight: 20,
        automaticLayout: true,
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        tabSize: 2,
        insertSpaces: true,
        wordWrap: 'off',
        renderLineHighlight: 'all',
        cursorBlinking: 'smooth',
        cursorSmoothCaretAnimation: 'on',
        padding: { top: 8, bottom: 8 },
        bracketPairColorization: { enabled: true },
        guides: { bracketPairs: 'active', indentation: true },
        // Monaco defaults semanticHighlighting to "configuredByTheme", and
        // defineTheme-created custom themes never opt in — so LSP semantic
        // tokens were computed (IPC + tsserver round trip) and then never
        // painted. Explicit true is the only way to get semantic colors
        // with our custom themes (#513).
        'semanticHighlighting.enabled': true,
      })
      const createdEditor = editor
      cleanups.push(() => {
        createdEditor.dispose()
        if (editorRef.current === createdEditor) editorRef.current = null
      })
      editorRef.current = editor
      const changeDisposable = model.onDidChangeContent(() => {
        if (!file) return
        onChange(file.path, model?.getValue() ?? '')
      })
      cleanups.push(() => changeDisposable.dispose())
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSave())

      // ── LSP wiring (#513) ──────────────────────────────────────────
      // The transcript CodeBlock had all of this from day one; the actual
      // FILE EDITOR never did. clientUri must be exactly
      // model.uri.toString(): the semantic-token provider and every
      // request in editorLanguageFeatures key their main-process doc
      // lookup on it.
      ensureEditorLanguageFeatures(monaco, file.language)
      if (supportsLsp(file.language)) {
        const clientUri = model.uri.toString()
        await ensureSemanticProvider(monaco, projectRoot, file.language).catch(() => {
          // fail open — same rationale as CodeBlock: a broken language
          // server must never mean a broken editor.
        })
        if (disposed) return
        await window.api.openLspDocument({
          clientUri,
          content: file.currentText,
          language: file.language,
          workspaceRoot: projectRoot,
          filePath: file.path,
        })
        if (disposed) return
        // NOTE: the LSP doc closes on COMPONENT unmount (tab switch),
        // not on tab close like the Monaco model. That's deliberate churn
        // for now — reopen re-syncs cheaply; aligning LSP doc lifetime
        // with the model registry is a follow-up once something actually
        // needs background-document diagnostics.
        cleanups.push(() => void window.api.closeLspDocument(clientUri))

        const unsubDiag = window.api.onLspDiagnostics(event => {
          if (event.clientUri !== clientUri) return
          if (!model || model.isDisposed()) return
          monaco.editor.setModelMarkers(
            model,
            'agent-code-lsp',
            event.diagnostics.map(d => ({
              message: d.message,
              startLineNumber: d.startLine + 1,
              startColumn: d.startCharacter + 1,
              endLineNumber: d.endLine + 1,
              endColumn: d.endCharacter + 1,
              severity:
                d.severity === 'error'
                  ? monaco.MarkerSeverity.Error
                  : d.severity === 'warning'
                    ? monaco.MarkerSeverity.Warning
                    : d.severity === 'info'
                      ? monaco.MarkerSeverity.Info
                      : monaco.MarkerSeverity.Hint,
            })),
          )
        })
        cleanups.push(unsubDiag)

        // Debounced change sync. 200ms: fast enough that diagnostics
        // feel live, slow enough that a keystroke burst is one didChange,
        // not thirty IPC round trips.
        let changeTimer: number | null = null
        const lspChangeSub = model.onDidChangeContent(() => {
          if (changeTimer !== null) window.clearTimeout(changeTimer)
          changeTimer = window.setTimeout(() => {
            changeTimer = null
            if (!model || model.isDisposed()) return
            void window.api.changeLspDocument(clientUri, model.getValue())
          }, 200)
        })
        cleanups.push(() => {
          lspChangeSub.dispose()
          if (changeTimer !== null) window.clearTimeout(changeTimer)
        })
      }

      if (file.selection) {
        editor.setPosition({
          lineNumber: file.selection.line,
          column: file.selection.column,
        })
        editor.revealLineInCenter(file.selection.line)
        onSelectionRevealed?.(file.path)
      }
      editor.focus()
    })()

    return () => {
      disposed = true
      // LIFO so resources that depend on earlier ones release first
      // (diagnostics unsub before editor dispose, editor before theme).
      for (let i = cleanups.length - 1; i >= 0; i--) {
        try {
          cleanups[i]()
        } catch {
          // best-effort teardown
        }
      }
    }
  }, [file?.path, projectRoot, onSelectionRevealed])

  useEffect(() => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model || !file) return
    if (model.getValue() === file.currentText) return
    const selection = editor.getSelection()
    model.setValue(file.currentText)
    if (selection) editor.setSelection(selection)
  }, [file?.currentText, file?.path])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !file?.selection) return
    // WHY selection is kept on the buffer instead of firing a one-off
    // imperative command from the markdown click handler: Global Editor file
    // opens are asynchronous. The file may be read before Monaco has mounted
    // its model, or the user may click the same already-open file with a new
    // line suffix. Storing the requested location beside the active buffer
    // lets both the first mount and later same-file activations converge on
    // the same "show this location" behavior without reaching through
    // component refs from untrusted rendered-content click handlers.
    editor.setPosition({
      lineNumber: file.selection.line,
      column: file.selection.column,
    })
    editor.revealLineInCenter(file.selection.line)
    editor.focus()
    onSelectionRevealed?.(file.path)
  }, [file?.path, file?.selection?.line, file?.selection?.column, onSelectionRevealed])

  if (!file) {
    return (
      <div className="flex h-full items-center justify-center bg-canvas text-[12px] text-muted">
        No file open
      </div>
    )
  }

  // NOTE: buffer errors are deliberately NOT handled here anymore. They
  // used to replace this whole pane, which hid the user's unsaved text at
  // the exact moment a save failed. EditorWorkbench renders
  // EditorStatusBanner above the editor instead (#513).
  return <div ref={containerRef} className="h-full min-h-0 min-w-0 bg-canvas" />
}
