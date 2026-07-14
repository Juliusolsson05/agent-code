import { memo } from 'react'

import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { StreamingProse, TextProse } from '@renderer/features/feed/ui/markdown'

// ThinkingBlock — the ONE thinking/reasoning surface, replacing the
// near-identical JSX that lived twice (live: BlockRow's thinking
// branch; committed: Block.tsx's thinking case) and drifted in small
// ways. Design rules preserved from the 2026-04-18 rework:
//
//   - Empty thinking renders NOTHING. The WorkIndicator owns the
//     "Thinking · Ns" affordance; a static placeholder row read as
//     "hung" when reasoning was encrypted.
//   - Non-empty thinking is a collapsed <details>, closed by default.
//
// New: `redacted` renders an explicit "redacted by provider" pill —
// redacted_thinking blocks used to fall through to an empty text
// branch and silently vanish (audit dropped-shape #1). Showing that
// something WAS there but is unreadable beats pretending it never
// happened (the pipeline's show-and-explain ethos).
//
// `streaming` picks the markdown flavor: StreamingProse keeps hard
// newlines as <br> (live reasoning arrives line-oriented), TextProse
// is standard committed markdown. A status flag, not a plane flag —
// finalized live thinking renders exactly like its committed twin.

export const ThinkingBlock = memo(function ThinkingBlock({
  text,
  streaming = false,
  redacted = false,
}: {
  text: string
  streaming?: boolean
  redacted?: boolean
}) {
  if (redacted) {
    return (
      <MarkerRow marker="⏺" tone="muted">
        <span className="text-[11px] text-ink-dim border border-border rounded px-1.5 py-px select-none">
          ∴ thinking redacted by provider
        </span>
      </MarkerRow>
    )
  }
  if (!text) return null
  return (
    <MarkerRow marker="⏺" tone="muted">
      <details className="italic text-muted text-[12px] opacity-80">
        <summary className="cursor-pointer select-none">
          ∴ Thinking{streaming ? '…' : ''}
          <span className="ml-2 not-italic text-ink-dim opacity-70">
            (click to expand)
          </span>
        </summary>
        <div className="mt-2 text-ink-dim opacity-90 not-italic">
          {streaming ? <StreamingProse text={text} /> : <TextProse text={text} />}
        </div>
      </details>
    </MarkerRow>
  )
})
