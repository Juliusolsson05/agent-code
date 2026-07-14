import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import type * as Monaco from 'monaco-editor'
import hljs from 'highlight.js'

import {
  languageFileExtension,
  normalizeCodeLanguage,
  supportsLsp,
} from '@shared/code/language'
import { APP_PROTOCOL_SCHEME } from '@shared/appIdentity'
import {
  THEME_CHANGED_EVENT,
  getActiveAppFontFamily,
} from '@renderer/app-state/settings/theme'
import {
  registerCodeBlock,
  unregisterCodeBlock,
} from '@renderer/features/copy-code-block/lib/codeBlockRegistry'

import { applyIncrementalModelText } from './incrementalModel'

type Props = {
  code: string
  language?: string | null
  path?: string | null
  workspaceRoot?: string | null
  codeId?: string
  engine?: 'static' | 'monaco'
  allowAutoDetect?: boolean
  /** When false, skip syntax highlighting and render the code as
   *  plain monospace text. Default true.
   *
   *  WHY this exists: highlight.js re-highlights the WHOLE `code`
   *  string every time it changes. That's fine for static content,
   *  but a caller that feeds a growing buffer — e.g. the live
   *  streaming `Write` preview, which re-renders on every
   *  `input_json_delta` — pays O(total bytes²) of highlighting over
   *  the stream. Such callers pass `highlight={false}` so the live
   *  preview stays cheap; the fully-highlighted view is rendered
   *  once by the committed transcript after the stream finishes.
   *  Only consulted by the static engine — Monaco does its own
   *  incremental tokenization and isn't affected. */
  highlight?: boolean
}

type MonacoLifecycle = {
  disposed: boolean
  model: Monaco.editor.ITextModel | null
  pendingContent: string
  lspOpen: boolean
  lspContent: string
  syncFrame: number | null
  syncHeight: (() => void) | null
}

/**
 * Coalesce provider token bursts into one editor/LSP update per paint.
 *
 * WHY LSP is notified before the Monaco model changes: a model edit asks the
 * semantic-token provider for fresh tokens. Sending `didChange` first keeps
 * Electron IPC ordering aligned with that request, so the language server does
 * not answer the new model with positions from the previous buffer. Lexical
 * Monaco highlighting still updates in this same animation frame; semantic
 * color is allowed to arrive asynchronously afterward.
 */
function scheduleContentSync(lifecycle: MonacoLifecycle, clientUri: string): void {
  if (lifecycle.disposed || lifecycle.syncFrame !== null) return
  lifecycle.syncFrame = window.requestAnimationFrame(() => {
    lifecycle.syncFrame = null
    if (lifecycle.disposed) return

    const next = lifecycle.pendingContent
    if (lifecycle.lspOpen && lifecycle.lspContent !== next) {
      const previous = lifecycle.lspContent
      lifecycle.lspContent = next
      void window.api.changeLspDocument(clientUri, next).catch(() => {
        // LSP is an enrichment, never the source of truth for transcript text.
        // Restore the last acknowledged value so a later delta can retry; do
        // not turn a dead language server into an unhandled renderer rejection.
        if (lifecycle.lspContent === next) lifecycle.lspContent = previous
      })
    }
    if (lifecycle.model) {
      applyIncrementalModelText(lifecycle.model, next)
      lifecycle.syncHeight?.()
    }
  })
}

function inferClientUri(
  codeId: string,
  language: string,
  path?: string | null,
): string {
  if (path) {
    return `${APP_PROTOCOL_SCHEME}://file/${encodeURIComponent(path)}#${encodeURIComponent(codeId)}`
  }
  const ext = languageFileExtension(language)
  return `${APP_PROTOCOL_SCHEME}://snippet/${encodeURIComponent(codeId)}.${ext}`
}

export const CodeBlock = memo(function CodeBlock({
  code,
  language,
  path,
  workspaceRoot,
  codeId,
  engine = 'static',
  allowAutoDetect = false,
  highlight = true,
}: Props) {
  const normalizedLanguage = useMemo(
    () => normalizeCodeLanguage(language, path),
    [language, path],
  )
  const shouldUseStaticFallback =
    engine === 'monaco' && allowAutoDetect && normalizedLanguage === 'plaintext'

  // ALL hooks must be called unconditionally — React requires the same
  // hooks in the same order on every render. The early-return for static
  // rendering used to call useMemo/useRef/useId conditionally, which
  // crashed when shouldUseStaticFallback flipped (e.g. Codex sessions
  // with allowAutoDetect where the language resolves after first render).
  const containerRef = useRef<HTMLDivElement>(null)
  const reactId = useId().replace(/:/g, '_')
  const lifecycleRef = useRef<MonacoLifecycle | null>(null)
  // Store the identity that actually finished initializing, not a boolean.
  // When path/language/codeId changes React can reuse this component instance;
  // a plain `true` would briefly hide the lexical fallback while the new Monaco
  // document is still starting.
  const [readyClientUri, setReadyClientUri] = useState<string | null>(null)
  const clientUri = useMemo(
    () => inferClientUri(codeId ?? reactId, normalizedLanguage, path),
    [codeId, normalizedLanguage, path, reactId],
  )

  // Hoisted above the static early-return so React sees the same hooks
  // on every render. When the static path is active, containerRef.current
  // is null (the <div ref={containerRef}> isn't in the DOM) so the
  // effect bails immediately — no Monaco editor gets created.
  const useMonaco = engine !== 'static' && !shouldUseStaticFallback
  const monacoReady = readyClientUri === clientUri
  const highlighted = useMemo(() => {
    if (!code) return ''
    // Once Monaco owns the visible text, recomputing whole-buffer highlight.js
    // output for every streaming delta is pure discarded work. The lexical
    // fallback is only needed while the async editor starts (or forever for the
    // static engine), so stop tokenizing the moment that hand-off completes.
    if ((useMonaco && monacoReady) || !highlight) return null
    if (normalizedLanguage !== 'plaintext' && hljs.getLanguage(normalizedLanguage)) {
      return hljs.highlight(code, { language: normalizedLanguage }).value
    }
    if (allowAutoDetect) {
      return hljs.highlightAuto(code).value
    }
    return null
  }, [allowAutoDetect, code, highlight, monacoReady, normalizedLanguage, useMonaco])

  useEffect(() => {
    if (!useMonaco) return
    const lifecycle: MonacoLifecycle = {
      disposed: false,
      model: null,
      pendingContent: code,
      lspOpen: false,
      lspContent: '',
      syncFrame: null,
      syncHeight: null,
    }
    lifecycleRef.current = lifecycle
    // Collect ALL cleanup functions as they're created — even inside
    // the async block. The effect cleanup runs them all, regardless
    // of how far the async init got before unmount. This fixes the
    // MaxListenersExceeded leak: the old code stored cleanupDiagnostics
    // in a local that the cleanup closure couldn't reach if the async
    // hadn't finished yet, so the IPC listener was never removed.
    const cleanups: Array<() => void> = []

    void (async () => {
      const { ensureSemanticProvider, getMonaco } = await import('@renderer/lib/code/monacoRuntime')
      const monaco = await getMonaco()
      if (lifecycle.disposed || !containerRef.current) return

      const lspEnabled = Boolean(workspaceRoot && supportsLsp(normalizedLanguage))
      if (lspEnabled && workspaceRoot) {
        // Open the document BEFORE registering/instantiating the semantic-token
        // consumer. A provider can be global from an older block and Monaco may
        // request tokens as soon as a model appears; if the broker has not seen
        // didOpen yet, that first request returns null and a completed/static
        // block has no later edit that would make Monaco ask again.
        const openedContent = lifecycle.pendingContent
        try {
          await window.api.openLspDocument({
            clientUri,
            content: openedContent,
            language: normalizedLanguage,
            workspaceRoot,
            // A feed/reader code block is a historical or generated snapshot,
            // not the live on-disk document named by `path`. Multiple before,
            // after, and restored snippets can legitimately show that path at
            // once. Mapping all of them to the real file URI makes didClose for
            // one block tear down every sibling and lets incompatible versions
            // race. Keep the path for language/display inference but give each
            // block the broker's unique virtual server document.
            filePath: null,
          })
          if (lifecycle.disposed) {
            // The async didOpen may win the race with unmount. Close explicitly
            // here because the normal cleanup was registered only after open
            // succeeded; omitting this branch leaks a broker document.
            void window.api.closeLspDocument(clientUri)
            return
          }
          lifecycle.lspOpen = true
          lifecycle.lspContent = openedContent
          cleanups.push(() => {
            lifecycle.lspOpen = false
            void window.api.closeLspDocument(clientUri)
          })

          await ensureSemanticProvider(monaco, workspaceRoot, normalizedLanguage).catch(() => {
            // WHY semantic provider setup is allowed to fail open: Monaco's
            // built-in lexer and the immediate static fallback are still useful
            // when TypeScript cannot start. A transcript row has no sensible
            // recovery UI, and a future mount is allowed to retry registration.
          })
          if (lifecycle.disposed) return
        } catch {
          // Opening an enrichment document must never suppress the actual file
          // text. Continue with Monaco's built-in grammar and leave lspOpen
          // false so streaming updates do not hammer a failed broker.
        }
      }

      if (lifecycle.disposed || !containerRef.current) return

      const uri = monaco.Uri.parse(clientUri)
      const model = monaco.editor.createModel(
        lifecycle.pendingContent,
        normalizedLanguage,
        uri,
      )
      lifecycle.model = model
      cleanups.push(() => model.dispose())

      const editor = monaco.editor.create(containerRef.current, {
        model,
        readOnly: true,
        domReadOnly: true,
        // Monaco is not normal DOM text. Its editor CSS owns a private
        // `--monaco-monospace-font` fallback and its layout engine caches
        // font metrics, so inheriting `font-code` on `.code-block-shell`
        // is not enough. This must be passed as an editor option or the
        // global settings picker appears broken exactly where users look
        // for font changes most often: syntax-highlighted tool output.
        //
        // WHY read through `getActiveAppFontFamily()` instead of
        // importing settings here: `applyTheme` already resolves the
        // curated id to the final CSS font-family declaration and writes
        // the authoritative variable. Keeping Monaco on that same read
        // path prevents a second resolver from drifting when fonts are
        // added, removed, or reordered.
        fontFamily: getActiveAppFontFamily(),
        minimap: { enabled: false },
        lineNumbers: 'off',
        folding: false,
        glyphMargin: false,
        scrollBeyondLastLine: false,
        renderLineHighlight: 'none',
        roundedSelection: false,
        overviewRulerBorder: false,
        overviewRulerLanes: 0,
        lineDecorationsWidth: 0,
        wordWrap: 'off',
        wrappingIndent: 'none',
        automaticLayout: true,
        smoothScrolling: true,
        contextmenu: false,
        links: false,
        hover: { enabled: false },
        occurrencesHighlight: 'off',
        selectionHighlight: false,
        matchBrackets: 'never',
        guides: { indentation: false, bracketPairs: false },
        scrollbar: {
          vertical: 'auto',
          horizontal: 'auto',
          verticalScrollbarSize: 8,
          horizontalScrollbarSize: 8,
          alwaysConsumeMouseWheel: false,
        },
      })
      cleanups.push(() => editor.dispose())

      const syncHeight = () => {
        const nextHeight = Math.min(Math.max(editor.getContentHeight(), 48), 360)
        if (containerRef.current) {
          containerRef.current.style.height = `${nextHeight}px`
          editor.layout()
        }
      }
      lifecycle.syncHeight = syncHeight

      syncHeight()
      const sizeSub = editor.onDidContentSizeChange(syncHeight)
      cleanups.push(() => sizeSub.dispose())

      const onThemeChanged = () => {
        // Monaco only remeasures/repaints its text layer when options are
        // updated through the editor API. Mutating the CSS variable alone
        // updates static <pre> blocks and chrome immediately, but Monaco
        // keeps rendering with its previous measured font until told
        // otherwise. `updateOptions` is deliberately scoped to
        // `fontFamily`; theme colors are handled globally in
        // monacoRuntime's THEME_CHANGED_EVENT listener.
        editor.updateOptions({ fontFamily: getActiveAppFontFamily() })
        syncHeight()
      }
      window.addEventListener(THEME_CHANGED_EVENT, onThemeChanged)
      cleanups.push(() => window.removeEventListener(THEME_CHANGED_EVENT, onThemeChanged))

      if (lifecycle.lspOpen) {
        const unsubDiag = window.api.onLspDiagnostics(event => {
          if (event.clientUri !== clientUri) return
          monaco.editor.setModelMarkers(
            model,
            'agent-code-lsp',
            event.diagnostics.map(diagnostic => ({
              message: diagnostic.message,
              startLineNumber: diagnostic.startLine + 1,
              startColumn: diagnostic.startCharacter + 1,
              endLineNumber: diagnostic.endLine + 1,
              endColumn: diagnostic.endCharacter + 1,
              severity:
                diagnostic.severity === 'error'
                  ? monaco.MarkerSeverity.Error
                  : diagnostic.severity === 'warning'
                    ? monaco.MarkerSeverity.Warning
                    : diagnostic.severity === 'info'
                      ? monaco.MarkerSeverity.Info
                      : monaco.MarkerSeverity.Hint,
            })),
          )
        })
        cleanups.push(unsubDiag)
      }

      if (lifecycle.disposed) return

      // A delta can land while Monaco/LSP are loading. The model was created
      // from the newest pending value, while this sync catches up an older
      // didOpen snapshot without replacing either long-lived object.
      scheduleContentSync(lifecycle, clientUri)
      setReadyClientUri(clientUri)

      const timer = window.setTimeout(() => syncHeight(), 0)
      cleanups.push(() => window.clearTimeout(timer))
    })()

    return () => {
      lifecycle.disposed = true
      if (lifecycle.syncFrame !== null) {
        window.cancelAnimationFrame(lifecycle.syncFrame)
        lifecycle.syncFrame = null
      }
      if (lifecycleRef.current === lifecycle) lifecycleRef.current = null
      // Run all cleanups in reverse order (LIFO) so resources that
      // depend on earlier ones are released first.
      for (let i = cleanups.length - 1; i >= 0; i--) {
        try { cleanups[i]() } catch { /* best-effort */ }
      }
    }
    // `code` is intentionally absent: content has a separate incremental
    // synchronization effect below. Adding it here recreates the exact
    // per-token model/editor/LSP churn this component is designed to prevent.
  }, [useMonaco, clientUri, normalizedLanguage, path, workspaceRoot])

  useEffect(() => {
    if (!useMonaco) return
    const lifecycle = lifecycleRef.current
    if (!lifecycle || lifecycle.disposed) return
    lifecycle.pendingContent = code
    scheduleContentSync(lifecycle, clientUri)
  }, [clientUri, code, useMonaco])

  // Register this block's exact source in the code-block registry so
  // the "Copy Code Block…" picker can copy it verbatim regardless of
  // render engine (a Monaco block has no DOM text node to scrape).
  // Keyed by `reactId`, the same unique id stamped on the root as
  // `data-code-block-id`. Re-runs when `code` changes (the streaming
  // Write preview grows its `code` on every delta); unregisters on
  // unmount — the unmount cleanup is the load-bearing half (a leaked
  // entry is a slow memory leak). Unconditional hook, placed with the
  // others so call order is stable across the static/Monaco branch.
  useEffect(() => {
    registerCodeBlock(reactId, code)
    return () => unregisterCodeBlock(reactId)
  }, [reactId, code])

  // Static/fallback early return — placed AFTER all hooks so the hook
  // call order is identical on every render regardless of code path.
  if (!useMonaco) {
    return (
      <pre
        data-code-block-id={reactId}
        className="code-block-static font-code text-[12px] leading-[1.6] whitespace-pre overflow-auto max-h-[360px] m-0 px-3 py-2 text-code-ink"
      >
        {highlighted == null ? (
          <code>{code}</code>
        ) : (
          <code
            className={`hljs${normalizedLanguage !== 'plaintext' ? ` language-${normalizedLanguage}` : ''}`}
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        )}
      </pre>
    )
  }

  return (
    <div
      data-code-block-id={reactId}
      className="code-block-shell relative w-full overflow-hidden"
    >
      {!monacoReady ? (
        // Monaco and typescript-language-server are lazy and can take visible
        // time on their first load. Keep useful lexical code on screen during
        // that wait; the semantic editor replaces it only once fully mounted.
        <pre className="code-block-static font-code text-[12px] leading-[1.6] whitespace-pre overflow-auto max-h-[360px] m-0 px-3 py-2 text-code-ink">
          {highlighted == null ? (
            <code>{code}</code>
          ) : (
            <code
              className={`hljs${normalizedLanguage !== 'plaintext' ? ` language-${normalizedLanguage}` : ''}`}
              dangerouslySetInnerHTML={{ __html: highlighted }}
            />
          )}
        </pre>
      ) : null}
      <div
        ref={containerRef}
        // Keep the host measurable while the fallback is visible. `absolute`
        // gives Monaco the same width without adding a second block to layout;
        // visibility flips only after editor creation, so there is no blank
        // semantic-upgrade frame.
        className={monacoReady ? 'w-full' : 'absolute inset-0 invisible pointer-events-none'}
        aria-hidden={monacoReady ? undefined : true}
      />
    </div>
  )
})
