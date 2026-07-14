import { useMemo } from 'react'
import hljs from 'highlight.js'

import { escapeHtml, toHighlightLanguage } from '@shared/code/htmlHighlight'
import { normalizeCodeLanguage } from '@shared/code/language'
import type { DiffLine } from '@shared/parsers/lineDiff'

/**
 * Render a precomputed DiffLine[] as a flat code slab with per-line
 * red/green tinting plus syntax-highlighted text inside each line.
 *
 * WHY this is provider-shared instead of duplicated in ClaudeRows and
 * CodexRows: both providers hand the renderer the same semantic object at this
 * point — an ordered list of added/removed/context lines plus an optional file
 * path for language detection. Keeping two copies made the browser-sizer fix
 * below live in only one provider's comments, so future edits could preserve
 * one path and regress the other. Provider-specific parsing still stays in the
 * provider row files; only this already-normalized display primitive is shared.
 */
export function DiffSlab({
  lines,
  filePath,
  emptyLabel,
}: {
  lines: DiffLine[]
  filePath?: string
  emptyLabel: string
}) {
  if (lines.length === 0) {
    return (
      <div className="bg-code-bg text-muted text-[11px] font-code px-3 py-2">
        {emptyLabel}
      </div>
    )
  }

  const highlightLanguage = useMemo(() => {
    return toHighlightLanguage(normalizeCodeLanguage(undefined, filePath))
  }, [filePath])
  const renderedLines = useMemo(
    () =>
      lines.map(line => {
        if (line.text === '') return '\u200b'
        if (!highlightLanguage) return escapeHtml(line.text)
        return hljs.highlight(line.text, { language: highlightLanguage }).value
      }),
    [highlightLanguage, lines],
  )

  return (
    <div className="bg-code-bg font-code text-[12px] leading-[1.55] overflow-x-auto">
      {/* Sizer wrapper — makes the block containing the lines as wide as the
          widest line (`w-max`) AND at least as wide as the viewport
          (`min-w-full`). Without this, each line div is block-level inside an
          overflow-x-auto parent, so its width collapses to the parent's
          content-box width (= the visible pane). When the user scrolled
          horizontally past the viewport, the diff tint stopped at the line
          div's right edge even though the text continued. The sizer forces
          every line div to stretch across the full scrollable width, so the
          +/- tint covers the whole line no matter how far right you scroll. */}
      <div className="w-max min-w-full">
        {lines.map((line, index) => {
          const bg =
            line.kind === '+'
              ? 'bg-diff-add-bg'
              : line.kind === '-'
                ? 'bg-diff-remove-bg'
                : ''
          const fg =
            line.kind === '+'
              ? 'text-diff-add-fg'
              : line.kind === '-'
                ? 'text-diff-remove-fg'
                : 'text-code-ink-dim'
          const bodyTone = line.kind === 'ctx' ? 'text-code-ink-dim' : 'text-code-ink'
          return (
            <div
              key={index}
              className={`${bg} flex items-start px-3 whitespace-pre`}
            >
              <span
                className={`${fg} select-none w-4 flex-shrink-0 tabular-nums`}
                aria-hidden="true"
              >
                {line.kind === 'ctx' ? ' ' : line.kind}
              </span>
              <span
                className={`${bodyTone} diff-line-code hljs flex-1 min-w-0 break-all`}
                dangerouslySetInnerHTML={{ __html: renderedLines[index] ?? '\u200b' }}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
