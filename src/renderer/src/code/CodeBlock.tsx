import { memo, useEffect, useId, useMemo, useRef } from 'react'
import hljs from 'highlight.js'

import {
  languageFileExtension,
  normalizeCodeLanguage,
  supportsLsp,
} from '../../../core/code/language'

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

  if (engine === 'static') {
    const highlighted = useMemo(() => {
      if (!code) return ''
      if (normalizedLanguage !== 'plaintext' && hljs.getLanguage(normalizedLanguage)) {
        return hljs.highlight(code, { language: normalizedLanguage }).value
      }
      if (allowAutoDetect) {
        return hljs.highlightAuto(code).value
      }
      return null
    }, [code, normalizedLanguage])

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

  const containerRef = useRef<HTMLDivElement>(null)
  const reactId = useId().replace(/:/g, '_')
  const clientUri = useMemo(
    () => inferClientUri(codeId ?? reactId, normalizedLanguage, path),
    [codeId, normalizedLanguage, path, reactId],
  )

  useEffect(() => {
    let disposed = false
    let cleanupDiagnostics: (() => void) | null = null
    let closeTimer: number | null = null
    let cleanupEditor: (() => void) | null = null

    void (async () => {
      const { ensureSemanticProvider, getMonaco } = await import('./monacoRuntime')
      const monaco = await getMonaco()
      if (disposed || !containerRef.current) return

      await ensureSemanticProvider(monaco, workspaceRoot, normalizedLanguage)
      const uri = monaco.Uri.parse(clientUri)
      const model = monaco.editor.createModel(code, normalizedLanguage, uri)
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

      const syncHeight = () => {
        const nextHeight = Math.min(Math.max(editor.getContentHeight(), 48), 360)
        if (containerRef.current) {
          containerRef.current.style.height = `${nextHeight}px`
          editor.layout()
        }
      }

      syncHeight()
      const sizeSub = editor.onDidContentSizeChange(syncHeight)

      if (workspaceRoot && supportsLsp(normalizedLanguage)) {
        await window.api.openLspDocument({
          clientUri,
          content: code,
          language: normalizedLanguage,
          workspaceRoot,
          filePath: path ?? null,
        })
        cleanupDiagnostics = window.api.onLspDiagnostics(event => {
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
      }

      if (disposed) {
        cleanupDiagnostics?.()
        sizeSub.dispose()
        editor.dispose()
        model.dispose()
        if (workspaceRoot && supportsLsp(normalizedLanguage)) {
          void window.api.closeLspDocument(clientUri)
        }
        return
      }

      closeTimer = window.setTimeout(() => {
        syncHeight()
      }, 0)

      cleanupEditor = () => {
        if (closeTimer != null) window.clearTimeout(closeTimer)
        cleanupDiagnostics?.()
        sizeSub.dispose()
        editor.dispose()
        model.dispose()
        if (workspaceRoot && supportsLsp(normalizedLanguage)) {
          void window.api.closeLspDocument(clientUri)
        }
      }
      if (disposed) cleanupEditor()
    })()

    return () => {
      disposed = true
      cleanupEditor?.()
    }
  }, [clientUri, code, engine, normalizedLanguage, path, workspaceRoot])

  return <div ref={containerRef} className="code-block-shell w-full overflow-hidden" />
})
