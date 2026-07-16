import hljs from 'highlight.js'
import { memo, useRef } from 'react'

// Sealed-line streaming highlighter (renderer rewrite PR #555, Phase 5 —
// ported from the PR #524 salvage list per tonight's product verdict:
// "streaming writes must be colored WHILE streaming, not on completion").
//
// WHY the legacy path streamed plain text: highlighting the WHOLE
// accumulated buffer on every token is O(total²) over a stream — the
// renderer-freeze class. The fix is an append-only observation: every line
// ABOVE the streaming cursor is FINAL ("sealed"), so it can be highlighted
// exactly once and cached by index; only the growing tail line re-tokenizes
// per delta. Cost per delta = O(new bytes). Purely lexical (hljs, per line,
// synchronous) — no LSP anywhere on this path, so color is same-frame by
// construction.
//
// Cache correctness: keyed by (language, line index, line text). A replayed
// or shrunk buffer (rare live re-fold) simply misses and re-highlights —
// the cache never serves stale HTML for changed text. Per-line hljs loses
// cross-line constructs (an unclosed template literal colors line-by-line),
// which is the accepted trade for instant streaming color; the COMMITTED
// card re-renders through the full highlighter and corrects any such line.
const LINE_CACHE_MAX = 5000

export const StreamingCodeText = memo(function StreamingCodeText({
  code,
  language,
  tone,
}: {
  code: string
  language: string
  /** 'added' renders every line in DiffSlab's diff-add grammar (green bg +
   *  `+` gutter) — a streaming Write IS pure additions, and matching the
   *  committed card's visuals makes the stream→committed handoff seamless
   *  (product verdict 2026-07-16: the green must be there WHILE streaming). */
  tone?: 'added'
}) {
  const cacheRef = useRef<{ lang: string; byLine: Map<number, { text: string; html: string }> }>({
    lang: language,
    byLine: new Map(),
  })
  if (cacheRef.current.lang !== language) {
    cacheRef.current = { lang: language, byLine: new Map() }
  }
  // normalizeCodeLanguage emits monaco-style ids; hljs has no
  // '(java|type)scriptreact' grammar, but the base grammar colors JSX/TSX
  // well enough for a streaming preview.
  const hljsLanguage = language.replace(/react$/, '')
  const canHighlight = hljsLanguage !== 'plaintext' && !!hljs.getLanguage(hljsLanguage)
  const lines = code.split('\n')
  const cache = cacheRef.current.byLine
  const lineHtml = (text: string, i: number): string => {
    if (!canHighlight) return ''
    const sealed = i !== lines.length - 1
    const hit = sealed ? cache.get(i) : undefined
    if (hit && hit.text === text) return hit.html
    // ignoreIllegals: a torn token mid-stream must color best-effort,
    // never throw into the paint.
    const html = hljs.highlight(text, { language: hljsLanguage, ignoreIllegals: true }).value
    if (sealed && cache.size < LINE_CACHE_MAX) cache.set(i, { text, html })
    return html
  }
  if (tone === 'added') {
    // DiffSlab's exact per-line grammar (bg + gutter + hljs body) so the
    // streaming preview and the committed diff card are the same picture.
    return (
      <div className="bg-code-bg font-code text-[12px] leading-[1.55] overflow-auto max-h-[360px]">
        <div className="w-max min-w-full">
          {lines.map((text, i) => (
            <div key={i} className="bg-diff-add-bg flex items-start px-3 whitespace-pre">
              <span className="text-diff-add-fg select-none w-4 flex-shrink-0 tabular-nums" aria-hidden="true">
                +
              </span>
              {canHighlight ? (
                <span
                  className="text-code-ink diff-line-code hljs flex-1 min-w-0 break-all"
                  dangerouslySetInnerHTML={{ __html: lineHtml(text, i) || '\u200b' }}
                />
              ) : (
                <span className="text-code-ink flex-1 min-w-0 break-all">{text || '\u200b'}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    )
  }
  return (
    <pre className="code-block-static font-code text-[12px] leading-[1.6] whitespace-pre overflow-auto max-h-[360px] m-0 px-3 py-2 text-code-ink">
      <code className={canHighlight ? `hljs language-${hljsLanguage}` : undefined}>
        {lines.map((text, i) => {
          const isTail = i === lines.length - 1
          if (!canHighlight) return <span key={i}>{text + (isTail ? '' : '\n')}</span>
          return (
            <span
              key={i}
              dangerouslySetInnerHTML={{ __html: lineHtml(text, i) + (isTail ? '' : '\n') }}
            />
          )
        })}
      </code>
    </pre>
  )
})
