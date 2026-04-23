import { memo } from 'react'

import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'

// The single-line "Conversation compacted" divider that appears at
// the boundary between a pre-compact and post-compact run of entries.
// Stateless — no props, no variants — it's a literal marker so the
// reader knows the conversation history was summarised here and the
// next message may not have context from above.
export const CompactBoundaryRow = memo(function CompactBoundaryRow() {
  return (
    <MarkerRow marker="·" tone="muted">
      <div className="text-[11px] uppercase tracking-wider text-muted">
        Conversation compacted
      </div>
    </MarkerRow>
  )
})
