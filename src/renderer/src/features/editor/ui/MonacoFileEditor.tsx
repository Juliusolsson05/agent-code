import { useEffect, useRef } from 'react'
import type * as Monaco from 'monaco-editor'

import { monacoLanguageId } from '@shared/code/language'
import { getMonaco } from '@renderer/lib/code/monacoRuntime'
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
    let acquiredModelPath: string | null = null
    let changeDisposable: Monaco.IDisposable | null = null
    let saveCommandId: string | null = null
    let editorThemeActive = false
    let monacoRuntime: typeof Monaco | null = null

    void (async () => {
      const monaco = await getMonaco()
      if (disposed) return
      monacoRuntime = monaco
      // Register and switch to the editor-mode theme before creating the
      // instance so the first paint already uses the canvas background
      // instead of flashing the darker code-slab theme. See
      // monacoEditorTheme.ts for the global-theme trade-off.
      activateEditorTheme(monaco)
      editorThemeActive = true
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
      acquiredModelPath = file.absolutePath
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
      editorRef.current = editor
      changeDisposable = model.onDidChangeContent(() => {
        if (!file) return
        onChange(file.path, model?.getValue() ?? '')
      })
      saveCommandId = editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
        () => onSave(),
      ) ?? null
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
      changeDisposable?.dispose()
      void saveCommandId
      editor?.dispose()
      if (editorThemeActive && monacoRuntime) {
        deactivateEditorTheme(monacoRuntime)
        editorThemeActive = false
      }
      // Viewer role only: release the refcount, never dispose here. The
      // model must outlive this component so the undo stack survives tab
      // switches; disposal happens on actual tab close via
      // disposeEditorModel — see editorModelRegistry's ownership contract.
      if (acquiredModelPath) releaseEditorModel(acquiredModelPath)
      if (editorRef.current === editor) editorRef.current = null
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
