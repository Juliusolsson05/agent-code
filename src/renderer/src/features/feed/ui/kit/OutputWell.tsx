import { memo, useState } from 'react'

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

  let capped = text
  let cappedNotice: string | null = null
  if (text.length > MAX_RENDER_CHARS) {
    const cut = text.slice(0, MAX_RENDER_CHARS)
    const dropped = text.slice(MAX_RENDER_CHARS).split('\n').length
    capped = cut
    cappedNotice = `… output truncated (${dropped} more ${dropped === 1 ? 'line' : 'lines'})`
  }

  const lines = capped.length === 0 ? [] : capped.split('\n')
  const needsTruncation = lines.length > previewLines
  const shown =
    expanded || !needsTruncation
      ? capped
      : lines.slice(0, previewLines).join('\n')
  const hiddenCount = needsTruncation ? lines.length - previewLines : 0

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
      {needsTruncation && (
        <button
          type="button"
          onClick={() => setExpanded(e => !e)}
          className="mt-1 text-[11px] text-muted hover:text-ink cursor-pointer"
        >
          {expanded
            ? 'collapse'
            : `… +${hiddenCount} ${hiddenCount === 1 ? 'line' : 'lines'} (click to expand)`}
        </button>
      )}
    </MarkerRow>
  )
})
