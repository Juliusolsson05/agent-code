import { memo, useMemo, useState } from 'react'

import type { CompactSummaryEntry } from '@shared/types/transcript'

import { compactSummaryText, truncateCompactSummary } from '@renderer/features/feed/lib/helpers'
import { TextProse } from '@renderer/features/feed/ui/markdown'

// Compact-summary entry renderer — the card that replaces a
// compacted run of turns with a human-readable summary. Shown as a
// full-width bordered card (deliberately NOT a MarkerRow) to signal
// this is meta-content derived from the original transcript, not
// another message in the conversation.
//
// Truncation: summaries can be long. If the body is >24 lines or
// >2400 chars we render a collapsed version with an "expand"
// toggle; the uncollapsed view is always available on demand. See
// truncateCompactSummary in lib/helpers.ts for the two-cap logic.
export const CompactSummaryRow = memo(function CompactSummaryRow({
  entry,
}: {
  entry: CompactSummaryEntry
}) {
  const [expanded, setExpanded] = useState(false)
  const text = useMemo(() => compactSummaryText(entry), [entry])
  const compact = text.length > 2400 || text.split('\n').length > 24
  const visibleText = compact && !expanded ? truncateCompactSummary(text) : text

  return (
    <div className="border border-border bg-surface">
      <div className="border-b border-border px-4 py-2 flex items-center justify-between gap-3">
        <div className="text-[11px] uppercase tracking-wider text-accent font-semibold">
          Conversation Summary
        </div>
        {compact && (
          <button
            type="button"
            onClick={() => setExpanded(prev => !prev)}
            className="text-[11px] font-code text-muted hover:text-ink transition-colors"
          >
            {expanded ? 'collapse' : 'expand'}
          </button>
        )}
      </div>
      <div className="px-4 py-3">
        <TextProse text={visibleText} />
      </div>
    </div>
  )
})
