import { memo, useContext, useMemo, useState } from 'react'
import hljs from 'highlight.js'

import { escapeHtml, toHighlightLanguage } from '@shared/code/htmlHighlight'
import { normalizeCodeLanguage } from '@shared/code/language'
import { formatToolFilePath } from '@shared/paths/displayPath'
import type { DiffLine } from '@shared/parsers/lineDiff'

import { CodeRenderContext } from '@renderer/features/feed/context'

// DiffView — the kit diff surface (DiffSlab's successor, spec §5.5).
// Consumes precomputed DiffLine[] (the component NEVER diffs); adds on
// top of the slab: an optional per-file header (tool label + RTL-
// truncated path + action/± stats) and long-diff windowing.
//
// The line-rendering core (per-line hljs tint inside red/green rows)
// and the `w-max min-w-full` sizer wrapper are PORTED VERBATIM from
// DiffSlab.tsx — the sizer is a shipped-bug tombstone: without it the
// +/- tint stopped at the visible pane's right edge when scrolling
// horizontally. The RTL path-truncation trick is ported from
// ClaudeRows.FileToolHeader (leading directories collapse, the
// filename stays visible).
//
// WHY windowing: a 2,000-line generated-file diff used to paint 2,000
// highlighted rows eagerly. Past WINDOW_THRESHOLD we render the first/
// last WINDOW_EDGE lines with an explicit "+N more lines" expander —
// explicit, never silent (the unknowns-contract ethos: a silent cut
// reads as "that was the whole diff").

const WINDOW_THRESHOLD = 96
const WINDOW_EDGE = 40

function DiffLines({ lines, filePath }: { lines: DiffLine[]; filePath?: string | null }) {
  const [expanded, setExpanded] = useState(false)

  const highlightLanguage = useMemo(
    () => toHighlightLanguage(normalizeCodeLanguage(undefined, filePath ?? undefined)),
    [filePath],
  )

  const windowed = !expanded && lines.length > WINDOW_THRESHOLD
  const visible = useMemo(() => {
    if (!windowed) return lines.map((line, i) => ({ line, key: i }))
    return [
      ...lines.slice(0, WINDOW_EDGE).map((line, i) => ({ line, key: i })),
      ...lines.slice(lines.length - WINDOW_EDGE).map((line, i) => ({
        line,
        key: lines.length - WINDOW_EDGE + i,
      })),
    ]
  }, [lines, windowed])

  const renderedLines = useMemo(
    () =>
      visible.map(({ line }) => {
        if (line.text === '') return '\u200b'
        if (!highlightLanguage) return escapeHtml(line.text)
        try {
          return hljs.highlight(line.text, { language: highlightLanguage, ignoreIllegals: true }).value
        } catch {
          return escapeHtml(line.text)
        }
      }),
    [highlightLanguage, visible],
  )

  const hiddenCount = windowed ? lines.length - WINDOW_EDGE * 2 : 0
  const expanderAt = windowed ? WINDOW_EDGE : -1

  return (
    <div className="bg-code-bg font-code text-[12px] leading-[1.55] overflow-x-auto">
      {/* Sizer wrapper — ported verbatim from DiffSlab (see header). */}
      <div className="w-max min-w-full">
        {visible.map(({ line, key }, index) => {
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
          const row = (
            <div key={key} className={`${bg} flex items-start px-3 whitespace-pre`}>
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
          if (index === expanderAt) {
            return (
              <div key={`exp:${key}`}>
                <button
                  type="button"
                  onClick={() => setExpanded(true)}
                  className="w-full text-left px-3 py-1 text-[11px] text-muted hover:text-ink cursor-pointer bg-code-bg"
                >
                  … +{hiddenCount} more {hiddenCount === 1 ? 'line' : 'lines'} (click to expand)
                </button>
                {row}
              </div>
            )
          }
          return row
        })}
      </div>
    </div>
  )
}

export type DiffViewFile = {
  path: string | null
  /** Codex apply_patch action badge; null for plain Edit diffs. */
  action: 'add' | 'update' | 'delete' | null
  movedTo: string | null
  lines: DiffLine[]
  /** Chunk label for multi-chunk single-file diffs (MultiEdit). */
  chunkLabel?: string | null
}

export const DiffView = memo(function DiffView({
  files,
  emptyLabel = '(no changes)',
  showHeaders = true,
}: {
  files: DiffViewFile[]
  emptyLabel?: string
  showHeaders?: boolean
}) {
  const { workspaceRoot } = useContext(CodeRenderContext)

  if (files.length === 0 || files.every(f => f.lines.length === 0 && !f.path)) {
    return (
      <div className="bg-code-bg text-muted text-[11px] font-code px-3 py-2">
        {emptyLabel}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {files.map((file, index) => {
        const display = file.path ? formatToolFilePath(file.path, workspaceRoot) : null
        const added = file.lines.filter(l => l.kind === '+').length
        const removed = file.lines.filter(l => l.kind === '-').length
        return (
          <div key={`${file.path ?? ''}:${index}`} className="flex flex-col gap-1">
            {showHeaders && (display || file.action || file.chunkLabel) ? (
              <div
                className="text-[12px] leading-[1.55] flex items-baseline gap-2 min-w-0"
                title={file.path ?? undefined}
              >
                {file.action ? (
                  <span
                    className={`text-[10px] uppercase tracking-wider flex-shrink-0 ${
                      file.action === 'delete' ? 'text-danger' : 'text-muted'
                    }`}
                  >
                    {file.action}
                  </span>
                ) : null}
                {display ? (
                  // RTL truncation: leading directories collapse, the
                  // filename stays visible (ported from FileToolHeader —
                  // see ClaudeRows history for the bidi caveat).
                  <span
                    className="text-ink-dim font-code truncate min-w-0"
                    style={{ direction: 'rtl', textAlign: 'left' }}
                  >
                    {display}
                  </span>
                ) : null}
                {file.movedTo ? (
                  <span className="text-muted text-[11px] flex-shrink-0">
                    → {formatToolFilePath(file.movedTo, workspaceRoot)}
                  </span>
                ) : null}
                {file.chunkLabel ? (
                  <span className="text-muted text-[10px] uppercase tracking-wider flex-shrink-0 select-none">
                    {file.chunkLabel}
                  </span>
                ) : null}
                {(added > 0 || removed > 0) && (
                  <span className="text-[11px] flex-shrink-0 tabular-nums">
                    {added > 0 ? <span className="text-diff-add-fg">+{added}</span> : null}
                    {added > 0 && removed > 0 ? ' ' : null}
                    {removed > 0 ? <span className="text-diff-remove-fg">−{removed}</span> : null}
                  </span>
                )}
              </div>
            ) : null}
            {file.lines.length > 0 ? (
              <DiffLines lines={file.lines} filePath={file.path} />
            ) : (
              <div className="bg-code-bg text-muted text-[11px] font-code px-3 py-2">
                {emptyLabel}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
})
