import { memo, useMemo, useState } from 'react'

import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'

import { AnsiText } from './AnsiText'

// The single collapsible output region for command/tool output — the
// kit successor to BOTH TruncatedOutputRow copies (the shared one at
// features/feed/ui/rows/TruncatedOutputRow.tsx and Codex's private
// byte-similar twin that lived in CodexRows.tsx @269f9fc; two copies =
// guaranteed drift, and neither was ANSI-aware).
//
// Behavior preserved from the originals (users have muscle memory):
// first 3 lines visible, click-to-expand button with the exact same
// copy, 360px scroll cap when expanded, error tint. Upgrades:
//   - ANSI-aware content (opt-out via ansi={false} for payloads known
//     to be markup-free where the probe cost isn't worth it).
//   - An explicit byte-cap notice. The old rows rendered unbounded
//     content once expanded; a whole-file `cat` could paint megabytes.
//     Truncation is LOUD (`… output truncated`) because a silent cut
//     reads as "that was all the output" — the same lie the rendering
//     pipeline's unknowns contract exists to prevent.

const RESULT_MAX_LINES = 3
// Generous — a long test run is ~100KB. The cap defends against
// pathological whole-file dumps, not normal output.
const MAX_RENDER_CHARS = 200_000

export const OutputWell = memo(function OutputWell({
  text,
  isError = false,
  ansi = true,
  previewLines = RESULT_MAX_LINES,
}: {
  text: string
  isError?: boolean
  ansi?: boolean
  previewLines?: number
}) {
  const [expanded, setExpanded] = useState(false)

  // Memoized: slicing + line-counting the dropped remainder of an
  // over-cap payload is O(dropped bytes) — running it on EVERY render
  // (including per-delta live renders) was a review perf finding.
  const { capped, cappedNotice } = useMemo(() => {
    if (text.length <= MAX_RENDER_CHARS) {
      return { capped: text, cappedNotice: null as string | null }
    }
    const dropped = text.slice(MAX_RENDER_CHARS).split('\n').length
    return {
      capped: text.slice(0, MAX_RENDER_CHARS),
      cappedNotice: `… output truncated (${dropped} more ${dropped === 1 ? 'line' : 'lines'})`,
    }
  }, [text])

  const lines = capped.length === 0 ? [] : capped.split('\n')
  // Head+tail preview, matching Codex's native output clipping
  // (exec_cell/render.rs output_lines): the START shows what ran and
  // the END shows how it finished — the tail is usually the part that
  // matters (test summary, error, exit line). Head-only previews hid
  // exactly that. Collapse only when it hides at least one line beyond
  // the head+tail window.
  const needsTruncation = lines.length > previewLines * 2 + 1
  const head = needsTruncation ? lines.slice(0, previewLines).join('\n') : capped
  const tail = needsTruncation ? lines.slice(-previewLines).join('\n') : ''
  const shown = expanded || !needsTruncation ? capped : head
  const hiddenCount = needsTruncation ? lines.length - previewLines * 2 : 0

  return (
    <MarkerRow marker="⎿" tone="muted">
      <pre
        className={`
          font-code text-[12px] leading-[1.55] whitespace-pre-wrap break-words m-0
          ${expanded ? 'max-h-[360px] overflow-auto' : ''}
          ${isError ? 'text-danger' : 'text-ink-dim'}
        `}
      >
        {ansi ? <AnsiText text={shown} /> : shown}
        {expanded && cappedNotice ? (
          <span className="text-muted">{`\n${cappedNotice}`}</span>
        ) : null}
      </pre>
      {needsTruncation && !expanded && (
        <>
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="my-0.5 text-[11px] text-muted hover:text-ink cursor-pointer block"
          >
            … +{hiddenCount} {hiddenCount === 1 ? 'line' : 'lines'} (click to expand)
          </button>
          <pre
            className={`
              font-code text-[12px] leading-[1.55] whitespace-pre-wrap break-words m-0
              ${isError ? 'text-danger' : 'text-ink-dim'}
            `}
          >
            {ansi ? <AnsiText text={tail} /> : tail}
          </pre>
        </>
      )}
      {needsTruncation && expanded && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-1 text-[11px] text-muted hover:text-ink cursor-pointer"
        >
          collapse
        </button>
      )}
    </MarkerRow>
  )
})
