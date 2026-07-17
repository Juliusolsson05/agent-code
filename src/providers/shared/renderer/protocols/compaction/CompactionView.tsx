import { memo, useMemo, useState } from 'react'

import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { TextProse } from '@renderer/features/feed/ui/markdown'
import { boundedTextPage } from '@renderer/lib/text/boundedText'
import type { CompactionRenderModel } from './model'
import { compactionSummaryPreview } from './model'

export const CompactionView = memo(function CompactionView({
  model,
}: {
  model: CompactionRenderModel
}) {
  if (model.kind === 'boundary') {
    return (
      <MarkerRow marker="·" tone="muted">
        <div className="text-[11px] uppercase tracking-wider text-muted">
          Conversation compacted
        </div>
      </MarkerRow>
    )
  }
  if (model.kind === 'progress') {
    return (
      <MarkerRow marker={model.phase === 'running' ? '◐' : '·'} tone="muted">
        <div className="text-[11px] uppercase tracking-wider text-muted">
          {model.label}
        </div>
      </MarkerRow>
    )
  }
  return <CompactionSummaryView text={model.text} />
})

const CompactionSummaryView = memo(function CompactionSummaryView({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  // WHY the same bounded scanner decides compactness and produces the preview:
  // a durable summary can be large, and a collapsed card must not allocate all
  // lines merely to discover that only the first 24 will paint.
  const compact = useMemo(() => boundedTextPage(text, 0, 2_400, 24).hasNext, [text])
  const visibleText = compact && !expanded ? compactionSummaryPreview(text) : text
  return (
    <div className="border border-border bg-surface">
      <div className="border-b border-border px-4 py-2 flex items-center justify-between gap-3">
        <div className="text-[11px] uppercase tracking-wider text-accent font-semibold">
          Conversation Summary
        </div>
        {compact ? (
          <button
            type="button"
            onClick={() => setExpanded(previous => !previous)}
            className="text-[11px] font-code text-muted hover:text-ink transition-colors"
          >
            {expanded ? 'collapse' : 'expand'}
          </button>
        ) : null}
      </div>
      <div className="px-4 py-3">
        <TextProse text={visibleText} />
      </div>
    </div>
  )
})
