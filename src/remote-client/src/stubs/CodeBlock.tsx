import { useMemo, useState } from 'react'
import hljs from 'highlight.js'

import { normalizeCodeLanguage } from '@shared/code/language'
import {
  boundedTextPage,
  collapsedTextPreview,
  exceedsInlineTextBudget,
} from '@renderer/lib/text/boundedText'

// Phone substitute for @renderer/lib/code/CodeBlock (aliased in
// vite.config.ts — see the alias table there and the semantic-rendering
// design doc). SAME props type as the desktop original ON PURPOSE: every
// desktop row that renders code keeps compiling unchanged against this
// module.
//
// What diverges, and why it's acceptable:
//   - engine="monaco" degrades to the static path. Monaco is a ~5 MB
//     editor runtime with LSP wiring over window.api — wrong for a phone
//     both in weight and in interaction model. The desktop's own markdown
//     fences, diffs, and git output already use the static engine, so the
//     majority of feed code surfaces render byte-identically; Read/Grep
//     results lose Monaco affordances (word-wrap toggle, LSP hovers) but
//     keep identical hljs token markup.
//   - No copy-code-block registry (codeId is accepted and ignored): that
//     feature is driven by desktop keybinds that don't exist on a phone.
//     Full-source copy remains available through the paging controls.
//
// What does NOT diverge, and why that is load-bearing: the size discipline.
// The stub used to highlight and mount the ENTIRE `code` string in one
// <pre> — but phone rows receive the same unbounded payloads desktop rows
// do (a multi-hundred-KB Read result), and expanding one froze the phone
// renderer, the exact failure class the desktop's pagination was built to
// kill. The stub now imports the SAME pure boundedText module the desktop
// uses (16KB/400-line pages, 2KB/6-line collapsed preview) so the two
// implementations cannot drift apart again: the budget lives in one file.
//
// The markup contract (pre.code-block-static > code.hljs.language-X) and
// the `highlight={false}` cheap-streaming path are preserved exactly —
// they are what make phone output match the desktop's static engine.

type Props = {
  code: string
  language?: string | null
  path?: string | null
  workspaceRoot?: string | null
  codeId?: string
  engine?: 'static' | 'monaco'
  allowAutoDetect?: boolean
  highlight?: boolean
}

export function CodeBlock({
  code,
  language,
  allowAutoDetect = false,
  highlight = true,
}: Props): React.JSX.Element {
  const oversized = useMemo(() => exceedsInlineTextBudget(code), [code])
  const [largeContentOpen, setLargeContentOpen] = useState(false)
  const [pageStarts, setPageStarts] = useState([0])
  const requestedPageStart = pageStarts[pageStarts.length - 1] ?? 0
  const visiblePage = useMemo(() => {
    if (!oversized) {
      return { text: code, start: 0, end: code.length, hasPrevious: false, hasNext: false }
    }
    return largeContentOpen ? boundedTextPage(code, requestedPageStart) : collapsedTextPreview(code)
  }, [code, largeContentOpen, oversized, requestedPageStart])

  const html = useMemo(() => {
    if (!highlight) return null
    // WHY an oversized collapsed block is always plain text (same verdict as
    // the desktop): highlighting even the preview during the initial feed
    // commit recreates the freeze this guard exists to prevent. Large
    // content is an explicit interaction; until then the phone owes the
    // user a responsive summary, not colors.
    if (oversized && !largeContentOpen) return null
    const normalized = normalizeCodeLanguage(language ?? null)
    try {
      if (normalized && hljs.getLanguage(normalized)) {
        return {
          className: `hljs language-${normalized}`,
          value: hljs.highlight(visiblePage.text, { language: normalized }).value,
        }
      }
      if (allowAutoDetect && visiblePage.text.length < 20_000) {
        return { className: 'hljs', value: hljs.highlightAuto(visiblePage.text).value }
      }
    } catch {
      // hljs throws on some malformed inputs; plain text is the safe floor.
    }
    return null
  }, [visiblePage.text, language, allowAutoDetect, highlight, largeContentOpen, oversized])

  const staticBlock = (
    /* max-w-full: on a phone this pins the block to the feed column so a long
     * code line scrolls INSIDE the block instead of widening the whole page
     * (the reported "everything is cramped/overflowing" symptom). No-op on
     * desktop, where the block already sits inside the 880px column.
     * px-3 py-2 text-code-ink: the desktop static path's own slab classes,
     * restored here so code rendered outside .prose-theme (Read results,
     * JSON slabs, live tool input) pads and inks identically on both
     * builds — the stub dropped these at birth and every such slab rendered
     * unpadded in the inherited ink. */
    <pre className="code-block-static font-code text-[12px] leading-[1.6] whitespace-pre overflow-auto max-w-full max-h-[360px] m-0 px-3 py-2 text-code-ink">
      {html ? (
        <code
          className={html.className}
          // Same trust story as the desktop static engine: hljs.highlight
          // output over text we already render as text — hljs escapes.
          dangerouslySetInnerHTML={{ __html: html.value }}
        />
      ) : (
        <code>{visiblePage.text}</code>
      )}
    </pre>
  )

  if (!oversized) return staticBlock

  // Paging controls mirror the desktop's largeContentControls row verbatim
  // (minus the registry-driven picker that doesn't exist here) so the
  // interaction vocabulary is identical across builds: expand → page →
  // collapse, full-source copy on explicit intent only.
  return (
    <div className="min-w-0">
      {staticBlock}
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
              onClick={() => void navigator.clipboard.writeText(code)}
            >
              copy full content
            </button>
          </>
        )}
      </div>
    </div>
  )
}
