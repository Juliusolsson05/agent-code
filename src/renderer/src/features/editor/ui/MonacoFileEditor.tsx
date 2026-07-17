import { useEffect, useRef, useState } from 'react'
import type * as Monaco from 'monaco-editor'

import { monacoLanguageId, supportsLsp } from '@shared/code/language'
import type { LspDocumentAuthorization } from '@shared/types/lsp'
import {
  ensureEditorLanguageFeatures,
  markEditorLspModelSynced,
  registerEditorLspContext,
  syncEditorLspModel,
} from '@renderer/lib/code/editorLanguageFeatures'
import {
  acquireEditorModel,
  editorViewState,
  replaceModelTextPreservingUndo,
  releaseEditorModel,
  saveEditorViewState,
} from '@renderer/features/editor/lib/editorModelRegistry'
import {
  activateEditorTheme,
  deactivateEditorTheme,
} from '@renderer/features/editor/lib/monacoEditorTheme'
import type { EditorFileBuffer } from '@renderer/features/editor/types'
import { THEME_CHANGED_EVENT, getActiveAppFontFamily } from '@renderer/app-state/settings/theme'

// Language servers keep a second full-text copy and every didChange crosses
// IPC. Editing remains fully available above this bound; only optional code
// intelligence is skipped so opening a generated/minified file cannot double
// its memory pressure or stall the renderer on repeated serialization.
const MAX_LSP_DOCUMENT_BYTES = 1_048_576

type Props = {
  file: EditorFileBuffer | null
  /** Explicit filesystem identity for LSP. UI/model identity is `file`;
   * multi-root AI Workspaces cannot use an opaque workspace id here. */
  lspContext: EditorLspContext | null
  onChange: (path: string, text: string) => void
  onSave: () => void
  onClose: () => void
  onSelectionRevealed?: (path: string) => void
  onFocusRequestHandled?: (path: string) => void
}

type EditorRuntimeStatus = {
  generation: number
  line: number
  column: number
  insertSpaces: boolean
  tabSize: number
  eol: 'LF' | 'CRLF'
}

function languageStatusLabel(language: string): string {
  if (language === 'typescriptreact') return 'TypeScript React'
  if (language === 'javascriptreact') return 'JavaScript React'
  if (language === 'typescript') return 'TypeScript'
  if (language === 'javascript') return 'JavaScript'
  if (language === 'plaintext') return 'Plain Text'
  if (language === 'makefile') return 'Makefile'
  return language.charAt(0).toUpperCase() + language.slice(1)
}

export type EditorLspContext = {
  workspaceRoot: string
  /** Project editors send their contained relative path. AI Workspace sends
   * null because main derives both root and file from the curated entry proof;
   * renderer metadata is never authoritative for that surface. */
  filePath: string | null
  authorization: LspDocumentAuthorization
  openDefinition: (absolutePath: string, line: number, column: number) => Promise<boolean>
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
  const [runtimeStatus, setRuntimeStatus] = useState<EditorRuntimeStatus | null>(null)
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
    const mountedOwner = file.generation
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
      if (
        !currentFile ||
        currentFile.absolutePath !== mountedPath ||
        currentFile.generation !== mountedOwner
      )
        return
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
      // File indentation is evidence already present in the document. Monaco
      // preserves that evidence when it exists, but empty/new files still need
      // a fallback. Using two spaces for every language produced invalid-feeling
      // Go and surprising Python/Rust files; these defaults mirror the dominant
      // conventions until a future project-settings layer can override them.
      const indentationFallback =
        currentFile.language === 'go' || currentFile.language === 'makefile'
          ? { insertSpaces: false, tabSize: 4 }
          : currentFile.language === 'python' || currentFile.language === 'rust'
            ? { insertSpaces: true, tabSize: 4 }
            : { insertSpaces: true, tabSize: 2 }
      model.detectIndentation(indentationFallback.insertSpaces, indentationFallback.tabSize)
      // Viewer role only: release the refcount on unmount, never dispose.
      // The model must outlive this component so the undo stack survives
      // tab switches; disposal happens on actual tab close via
      // releaseEditorModelOwner — see the registry's ownership contract.
      const acquiredModelOwner = currentFile.generation
      cleanups.push(() => releaseEditorModel(acquiredModelOwner))
      editor = monaco.editor.create(container, {
        model,
        readOnly: false,
        minimap: { enabled: true, renderCharacters: false, maxColumn: 100 },
        fontFamily: getActiveAppFontFamily(),
        fontSize: 13,
        lineHeight: 20,
        automaticLayout: true,
        scrollBeyondLastLine: false,
        smoothScrolling: true,
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
      const publishRuntimeStatus = () => {
        if (disposed || !model || model.isDisposed()) return
        const position = createdEditor.getPosition()
        const options = model.getOptions()
        setRuntimeStatus({
          generation: mountedOwner,
          line: position?.lineNumber ?? 1,
          column: position?.column ?? 1,
          insertSpaces: options.insertSpaces,
          tabSize: options.tabSize,
          eol: model.getEOL() === '\r\n' ? 'CRLF' : 'LF',
        })
      }
      const restoredViewState = editorViewState(mountedOwner)
      if (restoredViewState) editor.restoreViewState(restoredViewState)
      publishRuntimeStatus()
      const cursorStatusDisposable = editor.onDidChangeCursorPosition(publishRuntimeStatus)
      const modelOptionsDisposable = model.onDidChangeOptions(publishRuntimeStatus)
      cleanups.push(() => cursorStatusDisposable.dispose())
      cleanups.push(() => modelOptionsDisposable.dispose())
      cleanups.push(() => {
        // Monaco's editor instance owns scroll, folds, cursor and selections;
        // the long-lived model owns only text/undo. Persist the view before the
        // instance is disposed so ordinary tab switches feel continuous.
        saveEditorViewState(mountedOwner, createdEditor.saveViewState())
        createdEditor.dispose()
        if (editorRef.current === createdEditor) editorRef.current = null
      })
      editorRef.current = editor
      const onThemeChanged = () => {
        // Monaco measures glyphs outside normal CSS inheritance. Updating the
        // editor option is required for the app's font preference to change
        // both rendering and cursor geometry, matching transcript CodeBlocks.
        createdEditor.updateOptions({ fontFamily: getActiveAppFontFamily() })
      }
      window.addEventListener(THEME_CHANGED_EVENT, onThemeChanged)
      cleanups.push(() => window.removeEventListener(THEME_CHANGED_EVENT, onThemeChanged))
      const changeDisposable = model.onDidChangeContent(() => {
        publishRuntimeStatus()
        const latest = fileRef.current
        if (!latest || latest.absolutePath !== mountedPath || latest.generation !== mountedOwner)
          return
        onChangeRef.current(latest.path, model?.getValue(undefined, true) ?? '')
      })
      cleanups.push(() => changeDisposable.dispose())
      // addCommand installs an undisposable global keybinding in standalone
      // Monaco. addAction scopes the precondition to this editor id and gives
      // us a real disposable, so tab switches cannot accumulate stale saves.
      const saveAction = editor.addAction({
        id: `agent-code.save.${mountedOwner}.${encodeURIComponent(mountedPath)}`,
        label: 'Save File',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: () => onSaveRef.current(),
      })
      cleanups.push(() => saveAction.dispose())
      const closeAction = editor.addAction({
        id: `agent-code.close.${mountedOwner}.${encodeURIComponent(mountedPath)}`,
        label: 'Close File',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW],
        run: () => onCloseRef.current(),
      })
      cleanups.push(() => closeAction.dispose())

      // Focus and requested selection are core editor behavior, not an LSP
      // feature. Apply them before any language-server startup awaits so a
      // cold or missing server can never make an explicit file open feel
      // unresponsive for several seconds.
      const latestFile = fileRef.current
      if (!latestFile || latestFile.generation !== mountedOwner) return
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

      // ── LSP wiring (#513) ──────────────────────────────────────────
      // The transcript CodeBlock had all of this from day one; the actual
      // FILE EDITOR never did. clientUri must be exactly
      // model.uri.toString(): the semantic-token provider and every
      // request in editorLanguageFeatures key their main-process doc
      // lookup on it.
      ensureEditorLanguageFeatures(monaco, currentFile.language)
      const openedContent = model.getValue()
      const openedVersion = model.getVersionId()
      if (
        lspContext &&
        supportsLsp(currentFile.language) &&
        new Blob([openedContent]).size <= MAX_LSP_DOCUMENT_BYTES
      ) {
        const clientUri = model.uri.toString()
        await ensureSemanticProvider(
          monaco,
          lspContext.workspaceRoot,
          currentFile.language,
          lspContext.authorization,
        ).catch(() => {
          // fail open — same rationale as CodeBlock: a broken language
          // server must never mean a broken editor.
        })
        if (disposed) return
        const opened = await window.api
          .openLspDocument({
            clientUri,
            content: openedContent,
            language: currentFile.language,
            workspaceRoot: lspContext.workspaceRoot,
            filePath: lspContext.filePath,
            authorization: lspContext.authorization,
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
          let lspClosed = false
          const unregisterContext = registerEditorLspContext(clientUri, {
            workspaceRoot: lspContext.workspaceRoot,
            openDefinition: lspContext.openDefinition,
          })
          markEditorLspModelSynced(clientUri, openedVersion)
          const closeLsp = () => {
            if (lspClosed) return
            lspClosed = true
            unregisterContext()
            if (model && !model.isDisposed()) {
              monaco.editor.setModelMarkers(model, 'agent-code-lsp', [])
            }
            void window.api.closeLspDocument(clientUri).catch(() => undefined)
          }
          // NOTE: the LSP doc closes on COMPONENT unmount (tab switch),
          // not on tab close like the Monaco model. That's deliberate churn
          // for now — reopen re-syncs cheaply; aligning LSP doc lifetime
          // with the model registry is a follow-up once something actually
          // needs background-document diagnostics.
          cleanups.push(closeLsp)

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
            if (lspClosed) return
            if (changeTimer !== null) window.clearTimeout(changeTimer)
            if (new Blob([model?.getValue() ?? '']).size > MAX_LSP_DOCUMENT_BYTES) {
              // A document can cross the admission cap after didOpen. Stop the
              // subscription and close immediately: repeatedly sending an
              // oversized rejected didChange both leaks promise rejections and
              // leaves stale diagnostics looking authoritative.
              changeTimer = null
              lspChangeSub.dispose()
              closeLsp()
              return
            }
            changeTimer = window.setTimeout(() => {
              changeTimer = null
              if (!model || model.isDisposed() || lspClosed) return
              void syncEditorLspModel(model)
            }, 200)
          })
          cleanups.push(() => {
            lspChangeSub.dispose()
            if (changeTimer !== null) window.clearTimeout(changeTimer)
          })
          // Edits can land while server startup/open IPC is pending, before
          // the change subscription exists. Reconcile once after subscribing
          // so LSP never remains one edit behind until the next keystroke.
          if (new Blob([model.getValue()]).size > MAX_LSP_DOCUMENT_BYTES) {
            lspChangeSub.dispose()
            closeLsp()
          } else if (model.getVersionId() !== openedVersion) {
            void syncEditorLspModel(model)
          }
        }
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
  }, [file?.absolutePath, file?.generation, lspContext?.workspaceRoot, lspContext?.filePath])

  useEffect(() => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model || !file) return
    if (model.getValue(undefined, true) === file.currentText) return
    const selection = editor.getSelection()
    // An external clean-buffer refresh should remain undoable. setValue()
    // clears the entire undo stack, erasing unrelated local navigation/edit
    // history whenever an agent saves the file.
    replaceModelTextPreservingUndo(model, file.currentText)
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
  const currentStatus = runtimeStatus?.generation === file.generation ? runtimeStatus : null
  return (
    <div data-global-editor-input-owner="true" className="flex h-full min-h-0 min-w-0 flex-col">
      <div
        ref={containerRef}
        data-global-editor-monaco="true"
        className="min-h-0 min-w-0 flex-1 bg-canvas"
      />
      <div
        role="status"
        aria-live="off"
        aria-label="Editor position and file format"
        className="flex h-6 flex-shrink-0 items-center justify-end gap-3 border-t border-panel-border bg-tab-bg px-2 font-code text-[10px] text-muted"
      >
        {currentStatus && (
          <>
            <span>
              Ln {currentStatus.line}, Col {currentStatus.column}
            </span>
            <span>
              {currentStatus.insertSpaces ? 'Spaces' : 'Tab Size'}: {currentStatus.tabSize}
            </span>
            <span>{currentStatus.eol}</span>
          </>
        )}
        <span>{file.currentText.startsWith('\ufeff') ? 'UTF-8 with BOM' : 'UTF-8'}</span>
        <span>{languageStatusLabel(file.language)}</span>
      </div>
    </div>
  )
}
