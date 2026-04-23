import { memo, useEffect, useId, useMemo, useRef } from 'react'
import hljs from 'highlight.js'

import {
  languageFileExtension,
  normalizeCodeLanguage,
  supportsLsp,
} from '../../../../shared/code/language'

type Props = {
  code: string
  language?: string | null
  path?: string | null
  workspaceRoot?: string | null
  codeId?: string
  engine?: 'static' | 'monaco'
  allowAutoDetect?: boolean
}

function inferClientUri(
  codeId: string,
  language: string,
  path?: string | null,
): string {
  if (path) {
    return `cc-shell://file/${encodeURIComponent(path)}#${encodeURIComponent(codeId)}`
  }
  const ext = languageFileExtension(language)
  return `cc-shell://snippet/${encodeURIComponent(codeId)}.${ext}`
}

export const CodeBlock = memo(function CodeBlock({
  code,
  language,
  path,
  workspaceRoot,
  codeId,
  engine = 'static',
  allowAutoDetect = false,
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
  const highlighted = useMemo(() => {
    if (!code) return ''
    if (normalizedLanguage !== 'plaintext' && hljs.getLanguage(normalizedLanguage)) {
      return hljs.highlight(code, { language: normalizedLanguage }).value
    }
    if (allowAutoDetect) {
      return hljs.highlightAuto(code).value
    }
    return null
  }, [code, normalizedLanguage, allowAutoDetect])

  const containerRef = useRef<HTMLDivElement>(null)
  const reactId = useId().replace(/:/g, '_')
  const clientUri = useMemo(
    () => inferClientUri(codeId ?? reactId, normalizedLanguage, path),
    [codeId, normalizedLanguage, path, reactId],
  )

  // Hoisted above the static early-return so React sees the same hooks
  // on every render. When the static path is active, containerRef.current
  // is null (the <div ref={containerRef}> isn't in the DOM) so the
  // effect bails immediately — no Monaco editor gets created.
  const useMonaco = engine !== 'static' && !shouldUseStaticFallback
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
      const { ensureSemanticProvider, getMonaco } = await import('./monacoRuntime')
      const monaco = await getMonaco()
      if (disposed || !containerRef.current) return

      await ensureSemanticProvider(monaco, workspaceRoot, normalizedLanguage)
      if (disposed) return

      const uri = monaco.Uri.parse(clientUri)
      const model = monaco.editor.createModel(code, normalizedLanguage, uri)
      cleanups.push(() => model.dispose())

      const editor = monaco.editor.create(containerRef.current, {
        model,
        readOnly: true,
        domReadOnly: true,
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

      syncHeight()
      const sizeSub = editor.onDidContentSizeChange(syncHeight)
      cleanups.push(() => sizeSub.dispose())

      if (workspaceRoot && supportsLsp(normalizedLanguage)) {
        await window.api.openLspDocument({
          clientUri,
          content: code,
          language: normalizedLanguage,
          workspaceRoot,
          filePath: path ?? null,
        })
        if (disposed) return

        const unsubDiag = window.api.onLspDiagnostics(event => {
          if (event.clientUri !== clientUri) return
          monaco.editor.setModelMarkers(
            model,
            'cc-shell-lsp',
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
        try { cleanups[i]() } catch { /* best-effort */ }
      }
    }
  }, [useMonaco, clientUri, code, engine, normalizedLanguage, path, workspaceRoot])

  // Static/fallback early return — placed AFTER all hooks so the hook
  // call order is identical on every render regardless of code path.
  if (!useMonaco) {
    return (
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
    )
  }

  return <div ref={containerRef} className="code-block-shell w-full overflow-hidden" />
})
