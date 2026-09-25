import { memo, useMemo, useState } from 'react'

import { boundedTextPage } from '@renderer/lib/text/boundedText'
import { FeedPagerButtons } from '@renderer/features/feed/ui/rows/primitives'

export const PagedTextViewer = memo(function PagedTextViewer({
  source,
  isError = false,
  className = '',
}: {
  source: string
  isError?: boolean
  className?: string
}) {
  const [pageStarts, setPageStarts] = useState([0])
  const requestedStart = pageStarts[pageStarts.length - 1] ?? 0
  const page = useMemo(
    () => boundedTextPage(source, requestedStart),
    [requestedStart, source],
  )

  return (
    <div className="min-w-0">
      <pre
        className={`
          font-code text-[12px] leading-[1.55] whitespace-pre-wrap break-words m-0
          max-h-[360px] overflow-auto
          ${isError ? 'text-danger' : 'text-ink-dim'}
          ${className}
        `}
      >
        {page.text || '(no output)'}
      </pre>
      {(page.hasPrevious || page.hasNext) ? (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
          <span>
            characters {(page.start + 1).toLocaleString()}–{page.end.toLocaleString()} of{' '}
            {source.length.toLocaleString()}
          </span>
          <FeedPagerButtons
            hasPrevious={page.hasPrevious}
            hasNext={page.hasNext}
            onPrevious={() => setPageStarts(current => current.length > 1 ? current.slice(0, -1) : current)}
            onNext={() => setPageStarts(current => [...current, page.end])}
          />
        </div>
      ) : null}
    </div>
  )
})
