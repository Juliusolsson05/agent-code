import { memo, useContext, useId, useMemo, useRef } from 'react'
import hljs from 'highlight.js'

import { escapeHtml, toHighlightLanguage } from '@shared/code/htmlHighlight'
import { normalizeCodeLanguage } from '@shared/code/language'

import { CodeRenderContext } from '@renderer/features/feed/context'

import {
  SemanticTokenText,
  useSemanticTokenLines,
} from './SemanticTokenText'

// Line-by-line streaming code renderer — THE replacement for the
// per-delta Monaco remount that made live code fences jank. The old
// path (BlockRow.tsx fence branch @269f9fc) rendered the open fence
// through <CodeBlock engine="monaco">, whose Monaco effect lists `code`
// in its deps: every streaming token disposed and recreated the entire
// editor + model + LSP document. On top of that, the CodeBlock key
// embedded the fence language, so the info-string arriving one delta
// after the ``` remounted the block a second time.
//
// Contract:
//   - `code` is APPEND-ONLY across renders for a given `blockKey`.
//     Sealed lines (all but the last) are highlighted once and cached
//     by line index; only the partial tail line re-tokenizes per delta.
//     Appending a delta costs O(new bytes), not O(total bytes).
//   - `blockKey` identifies the stream. If it changes, the cache
//     resets. It must NOT embed the language (see above — that was
//     remount bug #2). Language changing (late info-string, path
//     resolution) invalidates the cache ONCE — cheap, happens within
//     the first few deltas — and never remounts the component.
//   - If `code` SHRINKS (contract violation — e.g. a caller reuses a
//     blockKey across streams), the stale cache tail is dropped rather
//     than painting ghost lines.
//
// WHY stateless per-line highlight (no cross-line state): highlight.js
// v11 removed the v10 `continuation` API. Per-line tokenization is
// wrong only for multi-line constructs (template literals, block
// comments) and self-repairs when the block finalizes — the committed
// path re-renders the same content through the one-shot whole-text
// highlighter. That trade buys the load-bearing property: a sealed
// line literally never re-renders.
//
// WHY a highlight cap: per-line span DOM over a pathological block
// (thousands of lines) still accumulates. Past MAX_HIGHLIGHT_LINES we
// stop highlighting NEW sealed lines (plain text spans, still
// append-only) — mirroring the old Write preview's highlight={false}
// escape hatch, but per-line instead of all-or-nothing.

const MAX_HIGHLIGHT_LINES = 2000

type SealedLine = { text: string; html: string | null }

export const StreamingCodeBlock = memo(function StreamingCodeBlock({
  code,
  language,
  path,
  blockKey,
  lineTone,
}: {
  code: string
  language?: string | null
  path?: string | null
  blockKey: string
  /**
   * Render each source line as a diff row. File Write uses `addition` because
   * the whole file is newly materialized from the user's point of view; the
   * explicit prop keeps ordinary markdown/code fences visually neutral.
   */
  lineTone?: 'addition' | 'removal'
}) {
  const semanticDocumentId = useId()
  const { workspaceRoot } = useContext(CodeRenderContext)
  const normalized = normalizeCodeLanguage(language ?? null, path ?? null)
  // Monaco-vocabulary → hljs-vocabulary (typescriptreact → typescript
  // etc.); null when hljs has no grammar → plain sealed lines.
  const hljsLanguage = normalized === 'plaintext' ? null : toHighlightLanguage(normalized)

  // Cache lives in a ref — mutated during render, never via state,
  // because a sealed line must not trigger a render of its own. Keyed
  // by blockKey + resolved language so either changing resets it
  // exactly once. Mutating a ref during render is safe here: the cache
  // is derived purely from props and the derivation is idempotent —
  // a concurrent re-render just re-derives the same lines.
  const cacheRef = useRef<{ key: string; lines: SealedLine[]; sealedSource: string }>({
    key: '',
    lines: [],
    sealedSource: '',
  })
  const cacheId = `${blockKey}\u0000${hljsLanguage ?? 'plain'}`
  if (cacheRef.current.key !== cacheId) {
    cacheRef.current = { key: cacheId, lines: [], sealedSource: '' }
  }

  const lines = useMemo(() => code.split('\n'), [code])
  const sealedCount = lines.length - 1 // the last line is the live tail
  const cache = cacheRef.current.lines
  if (cache.length > sealedCount) {
    cache.length = Math.max(0, sealedCount)
    cacheRef.current.sealedSource = cache.map(line => `${line.text}\n`).join('')
  }
  // Validate the WHOLE sealed prefix, not merely its last line. A provider tail
  // repair can alter an earlier line while leaving the last cached line equal;
  // the old one-line probe then painted stale source indefinitely. startsWith
  // enforces the documented append-only contract and resets on any divergence.
  if (
    cacheRef.current.sealedSource &&
    !code.startsWith(cacheRef.current.sealedSource)
  ) {
    cache.length = 0
    cacheRef.current.sealedSource = ''
  }
  for (let i = cache.length; i < sealedCount; i++) {
    const text = lines[i]
    let html: string | null = null
    if (hljsLanguage && i < MAX_HIGHLIGHT_LINES && text.length > 0) {
      try {
        html = hljs.highlight(text, { language: hljsLanguage, ignoreIllegals: true }).value
      } catch {
        html = null
      }
    }
    cache.push({ text, html })
    cacheRef.current.sealedSource += `${text}\n`
  }

  const tail = lines[lines.length - 1] ?? ''
  const tailHtml = useMemo(() => {
    if (!hljsLanguage || !tail) return null
    try {
      return hljs.highlight(tail, { language: hljsLanguage, ignoreIllegals: true }).value
    } catch {
      return null
    }
  }, [hljsLanguage, tail])
  const semanticLines = useSemanticTokenLines({
    content: code,
    language: normalized,
    path,
    workspaceRoot,
    documentKey: `stream:${blockKey}:${semanticDocumentId}:after`,
    enabled: lineTone !== undefined,
  })

  const toneKind = lineTone === 'addition' ? '+' : lineTone === 'removal' ? '-' : null
  // The gutter glyph is aria-hidden so copied code stays exact and a screen
  // reader does not announce punctuation with no meaning. Name each list item
  // with the semantic action instead; this mirrors DiffView's Added/Removed/
  // Context contract while leaving ordinary neutral code blocks untouched.
  const toneLabel = lineTone === 'addition' ? 'Added' : lineTone === 'removal' ? 'Removed' : null
  const toneBackground =
    lineTone === 'addition'
      ? 'bg-diff-add-bg'
      : lineTone === 'removal'
        ? 'bg-diff-remove-bg'
        : ''
  const toneForeground =
    lineTone === 'addition'
      ? 'text-diff-add-fg'
      : lineTone === 'removal'
        ? 'text-diff-remove-fg'
        : ''

  const renderToneRow = (
    line: SealedLine,
    key: string,
    lineIndex: number,
    appendNewline: boolean,
  ) => (
    <span
      key={key}
      data-stream-line-key={key}
      data-diff-kind={toneKind ?? undefined}
      role="listitem"
      aria-label={toneLabel ? `${toneLabel}: ${line.text === '\u200b' || !line.text ? 'blank line' : line.text}` : undefined}
      className={`${toneBackground} flex items-start px-3 whitespace-pre`}
    >
      <span
        className={`${toneForeground} select-none w-4 flex-shrink-0 tabular-nums`}
        aria-hidden="true"
      >
        {toneKind}
      </span>
      <SemanticTokenText
        text={line.text}
        lexicalHtml={`${line.html ?? escapeHtml(line.text)}${appendNewline ? '\n' : ''}`}
        ranges={semanticLines?.[lineIndex]}
        className="diff-line-code hljs flex-1 min-w-0 break-all text-code-ink"
      />
    </span>
  )

  if (toneKind) {
    // A trailing newline creates an empty split tail, but not another source
    // line. Omitting that tail prevents a phantom green row while retaining
    // real empty lines that were sealed by a following newline.
    const hasTail = tail.length > 0 || (code.length > 0 && !code.endsWith('\n'))
    const tailLine: SealedLine = { text: tail || '\u200b', html: tailHtml }
    return (
      <pre className="code-block-static font-code text-[12px] leading-[1.6] whitespace-pre overflow-auto max-h-[360px] m-0 p-0 text-code-ink">
        <code className={hljsLanguage ? `hljs language-${hljsLanguage}` : undefined}>
          <span
            className="block w-max min-w-full py-2"
            role="list"
            aria-label={lineTone === 'addition' ? 'Added file content' : 'Removed file content'}
          >
            {cache.map((line, i) =>
              renderToneRow(line, `${blockKey}:sealed:${i}`, i, true),
            )}
            {hasTail
              ? renderToneRow(
                  tailLine,
                  `${blockKey}:tail:${sealedCount}`,
                  sealedCount,
                  false,
                )
              : null}
          </span>
        </code>
      </pre>
    )
  }

  return (
    <pre className="code-block-static font-code text-[12px] leading-[1.6] whitespace-pre overflow-auto max-h-[360px] m-0 px-3 py-2 text-code-ink">
      <code className={hljsLanguage ? `hljs language-${hljsLanguage}` : undefined}>
        {cache.map((line, i) =>
          line.html !== null ? (
            // Trailing \n inside the span keeps copy/paste faithful and
            // lets `white-space: pre` own the line breaks — no <br>.
            <span
              key={`${blockKey}:sealed:${i}`}
              dangerouslySetInnerHTML={{ __html: `${line.html}\n` }}
            />
          ) : (
            <span key={`${blockKey}:sealed:${i}`}>{`${line.text}\n`}</span>
          ),
        )}
        {tailHtml !== null ? (
          <span
            key={`${blockKey}:tail:${sealedCount}`}
            dangerouslySetInnerHTML={{ __html: tailHtml }}
          />
        ) : (
          <span key={`${blockKey}:tail:${sealedCount}`}>{tail}</span>
        )}
      </code>
    </pre>
  )
})
