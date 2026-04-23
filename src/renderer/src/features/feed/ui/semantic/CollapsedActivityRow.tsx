import { memo } from 'react'

import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'

import type { SemanticRenderUnit } from '@renderer/features/feed/ui/semantic/types'

// Compact "worked: 3 reads, 1 search" tail for a finished batch of
// low-signal tool calls. Running-ness is the WorkIndicator's job
// now — when the group is still accumulating we render nothing and
// let the indicator below carry the "agent is working" signal.
// Only the `worked:` variant stays; it's a genuinely useful history
// compaction of a finished batch of reads/searches. See
// docs/superpowers/plans/2026-04-18-thinking-indicator-rework.md.
export const SemanticCollapsedActivityRow = memo(function SemanticCollapsedActivityRow({
  unit,
}: {
  unit: Extract<SemanticRenderUnit, { type: 'collapsed_activity' }>
}) {
  if (unit.isRunning) return null

  const parts: string[] = []
  if (unit.searchCount > 0) parts.push(`${unit.searchCount} search${unit.searchCount === 1 ? '' : 'es'}`)
  if (unit.readCount > 0) parts.push(`${unit.readCount} read${unit.readCount === 1 ? '' : 's'}`)
  if (unit.listCount > 0) parts.push(`${unit.listCount} list${unit.listCount === 1 ? '' : 's'}`)
  if (unit.bashCount > 0) parts.push(`${unit.bashCount} bash`)
  const summary = parts.length > 0 ? parts.join(', ') : `${unit.count} tool calls`

  return (
    <MarkerRow marker="⎿" tone="muted">
      <div className="flex flex-col gap-1">
        <div className="text-[12px] uppercase tracking-wider text-muted">
          worked: {summary}
        </div>
        {unit.latestHint ? (
          <div className="font-code text-[12px] leading-[1.5] text-ink-dim break-all">
            {unit.latestHint}
          </div>
        ) : null}
      </div>
    </MarkerRow>
  )
})
