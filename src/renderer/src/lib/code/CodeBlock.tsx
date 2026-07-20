import { memo, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import hljs from 'highlight.js'

import {
  languageFileExtension,
  monacoLanguageId,
  normalizeCodeLanguage,
  supportsTranscriptLsp,
} from '@shared/code/language'
import { APP_PROTOCOL_SCHEME } from '@shared/appIdentity'
import { THEME_CHANGED_EVENT, getActiveAppFontFamily } from '@renderer/app-state/settings/theme'
import {
  registerCodeBlock,
  unregisterCodeBlock,
} from '@renderer/features/copy-code-block/lib/codeBlockRegistry'
import { CodeRenderContext } from '@renderer/features/feed/context'
import {
  clearPendingSelection,
  setPendingSelection,
} from '@renderer/features/reply-to-selection/lib/selectionStash'
import {
  boundedTextPage,
  collapsedTextPreview,
  exceedsInlineTextBudget,
} from '@renderer/lib/text/boundedText'

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
  /** Transform only the currently admitted page before rendering it. This is
   *  intentionally page-scoped: normalizing a complete multi-megabyte Read
   *  result before pagination would make the closed row computationally open. */
  transformPage?: (page: string) => string
}

function inferClientUri(codeId: string, language: string, path?: string | null): string {
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
  transformPage,
}: Props) {
  const normalizedLanguage = useMemo(
    () => normalizeCodeLanguage(language, path, code),
    [code, language, path],
  )
  const oversized = useMemo(() => exceedsInlineTextBudget(code), [code])
  const [largeContentOpen, setLargeContentOpen] = useState(false)
  const [fullCopyState, setFullCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [pageStarts, setPageStarts] = useState([0])
  const requestedPageStart = pageStarts[pageStarts.length - 1] ?? 0
  const visiblePage = useMemo(() => {
    if (!oversized) {
      return {
        text: code,
        start: 0,
        end: code.length,
        hasPrevious: false,
        hasNext: false,
      }
    }
    return largeContentOpen ? boundedTextPage(code, requestedPageStart) : collapsedTextPreview(code)
  }, [code, largeContentOpen, oversized, requestedPageStart])
  const visibleCode = useMemo(
    () => (transformPage ? transformPage(visiblePage.text) : visiblePage.text),
    [transformPage, visiblePage.text],
  )
  const shouldUseStaticFallback =
    engine === 'monaco' && allowAutoDetect && normalizedLanguage === 'plaintext'

  // ALL hooks must be called unconditionally — React requires the same
  // hooks in the same order on every render. The early-return for static
  // rendering used to call useMemo/useRef/useId conditionally, which
  // crashed when shouldUseStaticFallback flipped (e.g. Codex sessions
  // with allowAutoDetect where the language resolves after first render).
  const highlighted = useMemo(() => {
    if (!visibleCode) return ''
    // WHY an oversized collapsed block is always plain text: highlighting even
    // the preview during the initial feed commit recreates the exact failure
    // this guard exists to prevent. Large content is an explicit interaction;
    // until then the renderer owes the user a responsive summary, not colors.
    if (oversized && !largeContentOpen) return null
    // Caller opted out of highlighting (e.g. a live streaming
    // preview) — return null so the static path renders a plain
    // <code> with no per-render hljs cost.
    if (!highlight) return null
    if (normalizedLanguage !== 'plaintext' && hljs.getLanguage(normalizedLanguage)) {
      return hljs.highlight(visibleCode, { language: normalizedLanguage }).value
    }
    if (allowAutoDetect) {
      return hljs.highlightAuto(visibleCode).value
    }
    return null
  }, [visibleCode, normalizedLanguage, allowAutoDetect, highlight, largeContentOpen, oversized])

  // Session that owns this code block, for the "Reply to Selection"
  // bridge in the Monaco effect below. Both the feed and Reader Mode
  // already provide this context; it is '' outside a session.
  const { sessionId: quoteSessionId } = useContext(CodeRenderContext)

  const containerRef = useRef<HTMLDivElement>(null)
  // INSTANT-PAINT LAYER (renderer rewrite PR #555; product-owner verdict
  // 2026-07-16: "LSP should kick in instantly"): Monaco + the LSP semantic
  // provider boot ASYNCHRONOUSLY — dynamic import, editor create, language
  // server round-trip — which left monaco-engine code blocks visibly
  // unstyled for seconds in the feed. Until the editor exists we render the
  // SAME synchronous hljs static block the static engine uses (the
  // `highlighted` memo is already computed above regardless of engine), then
  // swap Monaco in place. Layered tokens by design: plain text → lexical
  // colors in the same frame → Monaco/LSP semantics as a later, invisible
  // upgrade. First paint must never wait on a language server.
  const reactId = useId().replace(/:/g, '_')
  const clientUri = useMemo(
    // `codeId` is semantic identity for picker stability, not guaranteed DOM
    // uniqueness (two messages can start with the same 24 code characters).
    // Monaco rejects duplicate model URIs and LSP lifetime is keyed by that
    // URI, so every mounted instance must contribute React's unique id too.
    () => inferClientUri(`${codeId ?? 'anonymous'}:${reactId}`, normalizedLanguage, path),
    [codeId, normalizedLanguage, path, reactId],
  )

  // Hoisted above the static early-return so React sees the same hooks
  // on every render. When the static path is active, containerRef.current
  // is null (the <div ref={containerRef}> isn't in the DOM) so the
  // effect bails immediately — no Monaco editor gets created.
  // WHY large content starts on the static path even when a caller requested
  // Monaco: creating a hidden editor/model for the full payload would make a
  // visually collapsed row computationally open. After explicit expansion we
  // create Monaco for one bounded page only.
  const useMonaco =
    engine !== 'static' && !shouldUseStaticFallback && (!oversized || largeContentOpen)
  // Readiness belongs to one exact editor build, not to the component as a
  // boolean. On a code/page/language change React renders before useEffect can
  // dispose the old editor. A sticky `true` therefore hid the lexical layer;
  // cleanup then removed Monaco and left one blank frame before the effect's
  // setState(false) committed. The render-generation token makes readiness
  // false synchronously in that first rebuild render, so placeholder and old
  // editor exchange visibility without an empty paint. The token is local and
  // discarded on every dependency change—this is not content caching.
  const monacoBuild = useMemo(
    () => ({}),
    [clientUri, normalizedLanguage, useMonaco, visibleCode, workspaceRoot],
  )
  const [readyMonacoBuild, setReadyMonacoBuild] = useState<object | null>(null)
  const monacoReady = readyMonacoBuild === monacoBuild
  useEffect(() => {
    if (!useMonaco) return
    let disposed = false
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
      if (disposed || !containerRef.current) return

      if (workspaceRoot && supportsTranscriptLsp(normalizedLanguage)) {
        await ensureSemanticProvider(monaco, workspaceRoot, normalizedLanguage, {
          kind: 'editor-root',
        }).catch(() => {
          // WHY semantic provider setup is allowed to fail open: syntax-colored
          // code blocks are still useful when the bundled TypeScript server
          // cannot start. Other language servers are intentionally not started
          // for transcript snippets at all; supportsTranscriptLsp is the cost
          // boundary shared with didOpen below.
        })
      }
      if (disposed) return

      const uri = monaco.Uri.parse(clientUri)
      // monacoLanguageId: 'typescriptreact'/'javascriptreact' are LSP ids
      // Monaco doesn't ship — see language.ts. Without the mapping, .tsx
      // snippets render with the plaintext tokenizer (blank highlighting).
      // `visibleCode` is equally load-bearing: main now bounds oversized
      // transcript payloads before Monaco sees them, so restoring the old
      // full `code` value here would recreate the renderer-freeze regression.
      const model = monaco.editor.createModel(
        visibleCode,
        monacoLanguageId(normalizedLanguage),
        uri,
      )
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
        // See MonacoFileEditor — custom themes never enable semantic
        // tokens by default, so the LSP semantic-token provider this
        // component registers was painting nothing.
        'semanticHighlighting.enabled': true,
      })
      cleanups.push(() => editor.dispose())
      // Editor exists — retire the instant static placeholder. Semantic/LSP
      // tokens may still be pending, but Monaco's built-in tokenization
      // paints immediately from here, so the handoff is colored→colored.
      if (!disposed) setReadyMonacoBuild(monacoBuild)

      const syncHeight = () => {
        const nextHeight = Math.min(Math.max(editor.getContentHeight(), 48), 360)
        if (containerRef.current) {
          containerRef.current.style.height = `${nextHeight}px`
          editor.layout()
        }
      }

      syncHeight()
      const sizeSub = editor.onDidContentSizeChange(syncHeight)
      cleanups.push(() => sizeSub.dispose())

      // ── "Reply to Selection" bridge ──────────────────────────────────
      // Monaco keeps its selection in its own model over a hidden
      // textarea; it never becomes a document `Selection`. So the
      // document-level `selectionchange` listener that powers quoting is
      // structurally blind to text highlighted in here, and quoting code —
      // one of the most valuable things to quote — silently did nothing.
      //
      // The listener defers inside `.monaco-editor` (see
      // features/reply-to-selection/lib/quoteScope.ts) precisely so this
      // bridge can own these regions without the two racing.
      //
      // `quoteSessionId` comes from CodeRenderContext, which both the feed
      // and Reader Mode already provide. It is '' for code blocks rendered
      // outside a session (the standalone editor), and we deliberately do
      // not stash in that case — there is no composer to quote into.
      if (quoteSessionId) {
        const publishSelection = () => {
          const selection = editor.getSelection()
          if (!selection || selection.isEmpty()) {
            // Collapsing inside Monaco is the user dismissing their own
            // highlight — same meaning as an in-scope collapse in prose.
            clearPendingSelection()
            return
          }
          const text = model.getValueInRange(selection)
          if (text.trim().length === 0) {
            clearPendingSelection()
            return
          }
          setPendingSelection(quoteSessionId, text)
        }
        const quoteSub = editor.onDidChangeCursorSelection(publishSelection)
        cleanups.push(() => quoteSub.dispose())
      }

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

      if (workspaceRoot && supportsTranscriptLsp(normalizedLanguage)) {
        await window.api.openLspDocument({
          clientUri,
          content: visibleCode,
          language: normalizedLanguage,
          workspaceRoot,
          authorization: { kind: 'editor-root' },
          // A rendered transcript block is never the actual file, even when
          // the message labels it with a path. Sending that path would make a
          // partial/truncated snippet replace the real document in tsserver.
          filePath: null,
        })
        if (disposed) {
          // WHY close after a late open: unmount can happen while the main-process LSP handshake is
          // in flight. Returning without a matching close leaks a document/listener in the server.
          void window.api.closeLspDocument(clientUri)
          return
        }

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
        cleanups.push(() => void window.api.closeLspDocument(clientUri))
      }

      if (disposed) return

      const timer = window.setTimeout(() => syncHeight(), 0)
      cleanups.push(() => window.clearTimeout(timer))
    })()

    return () => {
      disposed = true
      // Run all cleanups in reverse order (LIFO) so resources that
      // depend on earlier ones are released first.
      for (let i = cleanups.length - 1; i >= 0; i--) {
        try {
          cleanups[i]()
        } catch {
          /* best-effort */
        }
      }
    }
  }, [useMonaco, clientUri, visibleCode, engine, monacoBuild, normalizedLanguage, path, workspaceRoot, quoteSessionId])

  // Register only the currently materialized page in the code-block registry.
  //
  // WHY this intentionally differs from the old "exact full source" contract:
  // the registry is a second long-lived owner, so registering a multi-megabyte
  // result defeats collapsing even if the DOM is bounded. The durable session
  // transcript remains the full source of truth; the picker describes what is
  // actually visible and copyable in this bounded viewer. Small blocks retain
  // the old exact-source behavior because `visibleCode === code`.
  // Keyed by `reactId`, the same unique id stamped on the root as
  // `data-code-block-id`. Re-runs when `code` changes (the streaming
  // Write preview grows its `code` on every delta); unregisters on
  // unmount — the unmount cleanup is the load-bearing half (a leaked
  // entry is a slow memory leak). Unconditional hook, placed with the
  // others so call order is stable across the static/Monaco branch.
  useEffect(() => {
    // WHY a collapsed oversized block has no registry entry at all: the copy
    // picker is another consumer of the same payload. Registering even the
    // collapsed preview makes a visually closed row computationally present
    // and causes every picker refresh to revisit work the user never opened.
    // The entry appears as soon as the user expands a bounded page, which is
    // also the first moment there is an honest "currently copyable" value.
    if (oversized && !largeContentOpen) return
    registerCodeBlock(reactId, visibleCode)
    return () => unregisterCodeBlock(reactId)
  }, [largeContentOpen, oversized, reactId, visibleCode])

  const largeContentControls = oversized ? (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
      <span>
        characters {(visiblePage.start + 1).toLocaleString()}–{visiblePage.end.toLocaleString()} of{' '}
        {code.length.toLocaleString()}
      </span>
      {!largeContentOpen ? (
        <button
          type="button"
          className="hover:text-ink cursor-pointer"
          onClick={() => setLargeContentOpen(true)}
        >
          view paged content
        </button>
      ) : (
        <>
          {visiblePage.hasPrevious ? (
            <button
              type="button"
              className="hover:text-ink cursor-pointer"
              onClick={() =>
                setPageStarts(current => (current.length > 1 ? current.slice(0, -1) : current))
              }
            >
              previous
            </button>
          ) : null}
          {visiblePage.hasNext ? (
            <button
              type="button"
              className="hover:text-ink cursor-pointer"
              onClick={() => setPageStarts(current => [...current, visiblePage.end])}
            >
              next
            </button>
          ) : null}
          <button
            type="button"
            className="hover:text-ink cursor-pointer"
            onClick={() => {
              setLargeContentOpen(false)
              setPageStarts([0])
            }}
          >
            collapse
          </button>
          <button
            type="button"
            className="hover:text-ink cursor-pointer"
            onClick={() => {
              // Full source is touched only after explicit user intent. Keeping it out of the
              // registry avoids a second long-lived owner; direct clipboard access preserves the
              // exact-content contract even though the visible editor remains page-bounded.
              void navigator.clipboard.writeText(code).then(
                () => setFullCopyState('copied'),
                () => setFullCopyState('failed'),
              )
            }}
          >
            {fullCopyState === 'copied'
              ? 'copied full content'
              : fullCopyState === 'failed'
                ? 'copy failed'
                : 'copy full content'}
          </button>
        </>
      )}
    </div>
  ) : null

  // Static/fallback early return — placed AFTER all hooks so the hook
  // call order is identical on every render regardless of code path.
  if (!useMonaco) {
    const staticBlock = (
      <pre
        data-code-block-id={reactId}
        className="code-block-static font-code text-[12px] leading-[1.6] whitespace-pre overflow-auto max-h-[360px] m-0 px-3 py-2 text-code-ink"
      >
        {highlighted == null ? (
          <code>{visibleCode}</code>
        ) : (
          <code
            className={`hljs${normalizedLanguage !== 'plaintext' ? ` language-${normalizedLanguage}` : ''}`}
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        )}
      </pre>
    )
    if (!oversized) return staticBlock
    return (
      <div className="min-w-0">
        {staticBlock}
        {largeContentControls}
      </div>
    )
  }

  const monacoBlock = (
    <div className="min-w-0">
      {/* Instant lexical layer: shown until the async Monaco editor exists.
          Same hljs output the static engine renders, so a TS/JSON block is
          colored in the SAME FRAME it first paints — never gated on the
          dynamic import or the LSP round-trip. */}
      {!monacoReady ? (
        <pre className="code-block-static font-code text-[12px] leading-[1.6] whitespace-pre overflow-auto max-h-[360px] m-0 px-3 py-2 text-code-ink">
          {highlighted == null ? (
            <code>{visibleCode}</code>
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
        data-code-block-id={reactId}
        className={`code-block-shell w-full overflow-hidden${monacoReady ? '' : ' h-0'}`}
      />
    </div>
  )
  if (!oversized) return monacoBlock
  return (
    <div className="min-w-0">
      {monacoBlock}
      {largeContentControls}
    </div>
  )
})
