import { useState } from 'react'

import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { collapsedTextPreview } from '@renderer/lib/text/boundedText'
import { PagedTextViewer } from '@renderer/lib/text/PagedTextViewer'

// Collapsed output view for tool_result content that isn't worth a
// dense so a long `find .` or noisy test run doesn't push the
// assistant's next message off-screen.
//
// WHY expansion is paged instead of putting `content` in one clipped <pre>:
// CSS clipping controls only visible height. The browser still creates text,
// layout, selection, and accessibility data for the complete string. That was
// one of the proven renderer-freeze paths: a row looked like 360px while doing
// work proportional to megabytes. The collapsed scan and expanded DOM are both
// bounded here; the durable transcript remains the owner of the full result.
export function TruncatedOutputRow({
  content,
  isError,
}: {
  content: string
  isError: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const preview = collapsedTextPreview(content)
  const needsTruncation = preview.hasNext
  return (
    <MarkerRow marker="⎿" tone="muted">
      {expanded ? (
        <PagedTextViewer source={content} isError={isError} />
      ) : (
        <pre
          className={`
            font-code text-[12px] leading-[1.55] whitespace-pre-wrap break-words m-0
            ${isError ? 'text-danger' : 'text-ink-dim'}
          `}
        >
          {preview.text || '(no output)'}
        </pre>
      )}
      {needsTruncation && (
        <button
          type="button"
          onClick={() => setExpanded(e => !e)}
          className="mt-1 text-[11px] text-muted hover:text-ink cursor-pointer"
        >
          {expanded
            ? 'collapse'
            : `… more output (${content.length.toLocaleString()} characters)`}
        </button>
      )}
    </MarkerRow>
  )
}
