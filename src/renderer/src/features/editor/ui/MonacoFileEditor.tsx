import { useEffect, useRef } from 'react'
import type * as Monaco from 'monaco-editor'

import { getMonaco } from '@renderer/lib/code/monacoRuntime'
import {
  currentEditorThemeName,
  ensureEditorThemes,
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
    let changeDisposable: Monaco.IDisposable | null = null
    let saveCommandId: string | null = null

    void (async () => {
      const monaco = await getMonaco()
      if (disposed) return
      // Register and switch to the editor-mode theme before creating the
      // instance so the first paint already uses the canvas background
      // instead of flashing the darker code-slab theme. See
      // monacoEditorTheme.ts for the global-theme trade-off.
      ensureEditorThemes(monaco)
      monaco.editor.setTheme(currentEditorThemeName())
      const uri = monaco.Uri.file(file.absolutePath)
      const existing = monaco.editor.getModel(uri)
      model = existing ?? monaco.editor.createModel(file.currentText, file.language, uri)
      if (existing && existing.getValue() !== file.currentText) {
        existing.setValue(file.currentText)
      }
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
      // WHY the model is kept alive only when another editor already owned it:
      // Monaco models are global by URI. The first editor slice recreates a
      // single editor per active file, so disposing models on tab switch is
      // fine. If a future split-editor view shares a file model across panes,
      // this should move into an editor document registry with reference
      // counts instead of component-local ownership.
      if (model && !model.isDisposed()) model.dispose()
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

  if (file.error) {
    return (
      <div className="flex h-full items-center justify-center bg-canvas p-6 text-[12px] text-danger">
        {file.error}
      </div>
    )
  }

  return <div ref={containerRef} className="h-full min-h-0 min-w-0 bg-canvas" />
}
