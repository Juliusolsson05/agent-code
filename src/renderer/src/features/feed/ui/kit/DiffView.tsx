import { memo, useContext, useId, useMemo, useRef, useState } from 'react'
import hljs from 'highlight.js'

import { escapeHtml, toHighlightLanguage } from '@shared/code/htmlHighlight'
import { normalizeCodeLanguage } from '@shared/code/language'
import { formatToolFilePath } from '@shared/paths/displayPath'
import type { DiffLine } from '@shared/parsers/lineDiff'

import { CodeRenderContext } from '@renderer/features/feed/context'

import {
  SemanticTokenText,
  useSemanticTokenLines,
} from './SemanticTokenText'

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

type KeyedDiffLine = { line: DiffLine; key: string }

function accessibleDiffLineLabel(line: DiffLine): string {
  // Color and the literal +/- gutter are intentionally aria-hidden visual
  // shorthand. A named list item gives assistive technology the missing
  // semantic verb without inserting screen-reader-only text into copied code.
  const kind = line.kind === '+' ? 'Added' : line.kind === '-' ? 'Removed' : 'Context'
  return `${kind}: ${line.text || 'blank line'}`
}

/**
 * Give a logical diff line the same React identity when a streaming parser
 * inserts or completes neighboring lines.
 *
 * WHY the old source index was not identity: a partial apply_patch grammar can
 * discover a hunk header/context line after later bytes arrive. React then
 * reused every following DOM row for different source text, which produced a
 * visible flash and invalidated any token work attached to those rows. Text +
 * kind + duplicate occurrence is deterministic across fresh parser arrays and
 * still distinguishes repeated blank/bracket lines inside one file.
 */
export function keyDiffLines(lines: DiffLine[]): KeyedDiffLine[] {
  const occurrences = new Map<string, number>()
  return lines.map(line => {
    const signature = JSON.stringify([line.kind, line.text])
    const occurrence = occurrences.get(signature) ?? 0
    occurrences.set(signature, occurrence + 1)
    return { line, key: `${signature}:${occurrence}` }
  })
}

function DiffLines({
  lines,
  filePath,
  semanticEnabled,
}: {
  lines: DiffLine[]
  filePath?: string | null
  semanticEnabled: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const semanticDocumentId = useId()
  const { workspaceRoot } = useContext(CodeRenderContext)

  const highlightLanguage = useMemo(
    () => toHighlightLanguage(normalizeCodeLanguage(undefined, filePath ?? undefined)),
    [filePath],
  )

  const keyedLines = useMemo(() => keyDiffLines(lines), [lines])
  const semanticSource = useMemo(() => {
    const before: string[] = []
    const after: string[] = []
    const coordinates = new Map<
      string,
      { beforeLine: number | null; afterLine: number | null }
    >()
    for (const item of keyedLines) {
      const beforeLine = item.line.kind === '+' ? null : before.length
      const afterLine = item.line.kind === '-' ? null : after.length
      if (beforeLine !== null) before.push(item.line.text)
      if (afterLine !== null) after.push(item.line.text)
      coordinates.set(item.key, { beforeLine, afterLine })
    }
    return {
      before: before.join('\n'),
      after: after.join('\n'),
      coordinates,
    }
  }, [keyedLines])
  const beforeSemanticLines = useSemanticTokenLines({
    content: semanticSource.before,
    path: filePath,
    workspaceRoot,
    documentKey: `diff:${semanticDocumentId}:before`,
    enabled: semanticEnabled,
  })
  const afterSemanticLines = useSemanticTokenLines({
    content: semanticSource.after,
    path: filePath,
    workspaceRoot,
    documentKey: `diff:${semanticDocumentId}:after`,
    enabled: semanticEnabled,
  })
  const windowed = !expanded && keyedLines.length > WINDOW_THRESHOLD
  const visible = useMemo(() => {
    if (!windowed) return keyedLines
    return [
      ...keyedLines.slice(0, WINDOW_EDGE),
      ...keyedLines.slice(keyedLines.length - WINDOW_EDGE),
    ]
  }, [keyedLines, windowed])

  // Provider parsers return a fresh DiffLine[] for every delta. Memoizing on
  // that array therefore re-highlighted the entire accumulated patch on every
  // token (quadratic over the stream). Cache by the stable logical key instead:
  // sealed rows become write-once, while the changing partial tail naturally
  // gets a new key and re-tokenizes. Pruning against the complete keyed list
  // prevents abandoned partial-tail variants from accumulating forever.
  const highlightCacheRef = useRef<{
    language: string | null
    values: Map<string, string>
  }>({ language: null, values: new Map() })
  if (highlightCacheRef.current.language !== highlightLanguage) {
    highlightCacheRef.current = { language: highlightLanguage, values: new Map() }
  }
  const highlightCache = highlightCacheRef.current.values
  const currentKeys = new Set(keyedLines.map(item => item.key))
  for (const key of highlightCache.keys()) {
    if (!currentKeys.has(key)) highlightCache.delete(key)
  }
  const renderedLines = visible.map(({ line, key }) => {
    const cached = highlightCache.get(key)
    if (cached !== undefined) return cached

    let rendered: string
    if (line.text === '') {
      rendered = '\u200b'
    } else if (!highlightLanguage) {
      rendered = escapeHtml(line.text)
    } else {
      try {
        rendered = hljs.highlight(line.text, {
          language: highlightLanguage,
          ignoreIllegals: true,
        }).value
      } catch {
        rendered = escapeHtml(line.text)
      }
    }
    highlightCache.set(key, rendered)
    return rendered
  })

  const hiddenCount = windowed ? keyedLines.length - WINDOW_EDGE * 2 : 0
  const expanderAt = windowed ? WINDOW_EDGE : -1

  return (
    <div
      className="bg-code-bg font-code text-[12px] leading-[1.55] overflow-x-auto"
      role="list"
      aria-label="File changes"
    >
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
          const coordinate = semanticSource.coordinates.get(key)
          const semanticRanges =
            line.kind === '-'
              ? coordinate?.beforeLine == null
                ? null
                : beforeSemanticLines?.[coordinate.beforeLine]
              : coordinate?.afterLine == null
                ? null
                : afterSemanticLines?.[coordinate.afterLine]
          const row = (
            <div
              key={key}
              data-diff-line-key={key}
              data-diff-kind={line.kind}
              role="listitem"
              aria-label={accessibleDiffLineLabel(line)}
              className={`${bg} flex items-start px-3 whitespace-pre`}
            >
              <span
                className={`${fg} select-none w-4 flex-shrink-0 tabular-nums`}
                aria-hidden="true"
              >
                {line.kind === 'ctx' ? ' ' : line.kind}
              </span>
              <SemanticTokenText
                text={line.text}
                lexicalHtml={renderedLines[index] ?? '\u200b'}
                ranges={semanticRanges}
                className={`${bodyTone} diff-line-code hljs flex-1 min-w-0 break-all`}
              />
            </div>
          )
          if (index === expanderAt) {
            return (
              <div key={`exp:${key}`} role="presentation">
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
              <DiffLines
                lines={file.lines}
                filePath={file.path}
                // One before/after pair is a useful bounded enrichment. A
                // MultiEdit/multi-file patch previously opened two LSP docs per
                // chunk and requested every one at stream cadence. Lexical
                // color remains immediate for those complex operations; LSP is
                // intentionally reserved for a single-file diff.
                semanticEnabled={files.length === 1}
              />
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
