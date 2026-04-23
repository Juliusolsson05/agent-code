import { useState } from 'react'

import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'

// MAX_LINES_TO_SHOW in claude-code-src. Hoisted so the memo'd row
// component doesn't re-create the constant every render.
const RESULT_MAX_LINES = 3

// Collapsed output view for tool_result content that isn't worth a
// full dump (Bash, Glob, LS, error stacks). Shows the first 3 lines
// and offers a click-to-expand button revealing the full output
// inside a 360px scroll cap. Mirrors claude-code's OutputLine +
// renderTruncatedContent from claude-code-src — keeping the feed
// dense so a long `find .` or noisy test run doesn't push the
// assistant's next message off-screen.
export function TruncatedOutputRow({
  content,
  isError,
}: {
  content: string
  isError: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const lines = content.length === 0 ? [] : content.split('\n')
  const needsTruncation = lines.length > RESULT_MAX_LINES
  const shown = expanded || !needsTruncation
    ? content
    : lines.slice(0, RESULT_MAX_LINES).join('\n')
  const hiddenCount = needsTruncation ? lines.length - RESULT_MAX_LINES : 0
  return (
    <MarkerRow marker="⎿" tone="muted">
      <pre
        className={`
          font-code text-[12px] leading-[1.55] whitespace-pre-wrap break-words m-0
          ${expanded ? 'max-h-[360px] overflow-auto' : ''}
          ${isError ? 'text-danger' : 'text-ink-dim'}
        `}
      >
        {shown}
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
}
