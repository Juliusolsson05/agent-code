import { useEffect, useRef } from 'react'
import type * as Monaco from 'monaco-editor'

import { monacoLanguageId, supportsLsp } from '@shared/code/language'
import {
  ensureEditorLanguageFeatures,
  registerEditorLspContext,
} from '@renderer/lib/code/editorLanguageFeatures'
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
  /** Explicit filesystem identity for LSP. UI/model identity is `file`;
   * multi-root AI Workspaces cannot use an opaque workspace id here. */
  lspContext: { workspaceRoot: string; filePath: string } | null
  onChange: (path: string, text: string) => void
  onSave: () => void
  onClose: () => void
  onSelectionRevealed?: (path: string) => void
  onFocusRequestHandled?: (path: string) => void
}

export function MonacoFileEditor({
  file,
  lspContext,
  onChange,
  onSave,
  onClose,
  onSelectionRevealed,
  onFocusRequestHandled,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const fileRef = useRef(file)
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const onCloseRef = useRef(onClose)
  const onSelectionRevealedRef = useRef(onSelectionRevealed)
  const onFocusRequestHandledRef = useRef(onFocusRequestHandled)
  fileRef.current = file
  onChangeRef.current = onChange
  onSaveRef.current = onSave
  onCloseRef.current = onClose
  onSelectionRevealedRef.current = onSelectionRevealed
  onFocusRequestHandledRef.current = onFocusRequestHandled

  useEffect(() => {
    const container = containerRef.current
    if (!container || !file) return
    const mountedPath = file.absolutePath
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
      // WHY this import must stay inside the mount path: CodeBlock is already
      // lazy, and a static import here pulled Monaco plus all workers into the
      // initial renderer chunk even when the Global Editor was never opened.
      const { ensureSemanticProvider, getMonaco } = await import('@renderer/lib/code/monacoRuntime')
      const monaco = await getMonaco()
      if (disposed) return
      const currentFile = fileRef.current
      if (!currentFile || currentFile.absolutePath !== mountedPath) return
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
        absolutePath: currentFile.absolutePath,
        text: currentFile.currentText,
        monacoLangId: monacoLanguageId(currentFile.language),
        ownerId: currentFile.generation,
      })
      // Viewer role only: release the refcount on unmount, never dispose.
      // The model must outlive this component so the undo stack survives
      // tab switches; disposal happens on actual tab close via
      // releaseEditorModelOwner — see the registry's ownership contract.
      const acquiredModelPath = currentFile.absolutePath
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
        const latest = fileRef.current
        if (!latest || latest.absolutePath !== mountedPath) return
        onChangeRef.current(latest.path, model?.getValue() ?? '')
      })
      cleanups.push(() => changeDisposable.dispose())
      // addCommand installs an undisposable global keybinding in standalone
      // Monaco. addAction scopes the precondition to this editor id and gives
      // us a real disposable, so tab switches cannot accumulate stale saves.
      const saveAction = editor.addAction({
        id: `agent-code.save.${encodeURIComponent(mountedPath)}`,
        label: 'Save File',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: () => onSaveRef.current(),
      })
      cleanups.push(() => saveAction.dispose())
      const closeAction = editor.addAction({
        id: `agent-code.close.${encodeURIComponent(mountedPath)}`,
        label: 'Close File',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW],
        run: () => onCloseRef.current(),
      })
      cleanups.push(() => closeAction.dispose())

      // ── LSP wiring (#513) ──────────────────────────────────────────
      // The transcript CodeBlock had all of this from day one; the actual
      // FILE EDITOR never did. clientUri must be exactly
      // model.uri.toString(): the semantic-token provider and every
      // request in editorLanguageFeatures key their main-process doc
      // lookup on it.
      ensureEditorLanguageFeatures(monaco, currentFile.language)
      if (lspContext && supportsLsp(currentFile.language)) {
        const clientUri = model.uri.toString()
        cleanups.push(registerEditorLspContext(clientUri, lspContext.workspaceRoot))
        const openedContent = model.getValue()
        await ensureSemanticProvider(monaco, lspContext.workspaceRoot, currentFile.language).catch(
          () => {
            // fail open — same rationale as CodeBlock: a broken language
            // server must never mean a broken editor.
          },
        )
        if (disposed) return
        const opened = await window.api
          .openLspDocument({
            clientUri,
            content: openedContent,
            language: currentFile.language,
            workspaceRoot: lspContext.workspaceRoot,
            filePath: lspContext.filePath,
          })
          .then(() => true)
          .catch(() => false)
        // A language server is an enhancement. Startup/spawn failure must not
        // abort selection reveal, focus, or the rest of editor initialization.
        if (opened && disposed) {
          void window.api.closeLspDocument(clientUri)
          return
        }
        if (!opened || disposed) {
          // Continue editor initialization without LSP when open failed.
        } else {
          // NOTE: the LSP doc closes on COMPONENT unmount (tab switch),
          // not on tab close like the Monaco model. That's deliberate churn
          // for now — reopen re-syncs cheaply; aligning LSP doc lifetime
          // with the model registry is a follow-up once something actually
          // needs background-document diagnostics.
          cleanups.push(() => void window.api.closeLspDocument(clientUri))
          cleanups.push(() => {
            if (!model || model.isDisposed()) return
            monaco.editor.setModelMarkers(model, 'agent-code-lsp', [])
          })

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
          // Edits can land while server startup/open IPC is pending, before
          // the change subscription exists. Reconcile once after subscribing
          // so LSP never remains one edit behind until the next keystroke.
          if (model.getValue() !== openedContent) {
            void window.api.changeLspDocument(clientUri, model.getValue())
          }
        }
      }

      const latestFile = fileRef.current
      if (!latestFile || latestFile.absolutePath !== mountedPath) return
      if (latestFile.selection) {
        editor.setPosition({
          lineNumber: latestFile.selection.line,
          column: latestFile.selection.column,
        })
        editor.revealLineInCenter(latestFile.selection.line)
        editor.focus()
        onSelectionRevealedRef.current?.(latestFile.path)
      } else if (latestFile.focusRequest !== null) {
        editor.focus()
        onFocusRequestHandledRef.current?.(latestFile.path)
      }
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
  }, [file?.absolutePath, lspContext?.workspaceRoot, lspContext?.filePath])

  useEffect(() => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model || !file) return
    if (model.getValue() === file.currentText) return
    const selection = editor.getSelection()
    const fullRange = model.getFullModelRange()
    // An external clean-buffer refresh should remain undoable. setValue()
    // clears the entire undo stack, erasing unrelated local navigation/edit
    // history whenever an agent saves the file.
    model.pushEditOperations([], [{ range: fullRange, text: file.currentText }], () => null)
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
    onSelectionRevealedRef.current?.(file.path)
  }, [file?.path, file?.selection?.line, file?.selection?.column, onSelectionRevealed])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !file || file.focusRequest === null) return
    editor.focus()
    onFocusRequestHandledRef.current?.(file.path)
  }, [file?.path, file?.focusRequest])

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
  return (
    <div
      ref={containerRef}
      data-global-editor-input-owner="true"
      className="h-full min-h-0 min-w-0 bg-canvas"
    />
  )
}
