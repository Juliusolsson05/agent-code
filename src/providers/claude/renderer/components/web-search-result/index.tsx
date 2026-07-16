import { useState } from 'react'

import type { ClaudeWebSearchResultModel } from '@providers/claude/renderer/adapters/web'
import { LazyTextProse } from '@providers/shared/renderer/components/lazy-prose'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'

export function ClaudeWebSearchResultRow({ model }: { model: ClaudeWebSearchResultModel }) {
  const [open, setOpen] = useState(false)
  const count = model.lineCountTruncated ? `≥${model.lineCount}` : String(model.lineCount)
  const noun = model.lineCount === 1 && !model.lineCountTruncated ? 'line' : 'lines'

  return (
    <MarkerRow marker="⎿" tone="muted">
      <details
        className="text-[12px] leading-[1.55] text-ink-dim"
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="cursor-pointer select-none min-w-0">
          Web search returned <span className="text-ink font-semibold">{count}</span> {noun} for{' '}
          <span className="text-ink-dim" title={model.query}>
            {model.query}
          </span>
        </summary>
        {/* Result text stays exact in the model; TextProse owns bounded
            Markdown admission and safe external-link routing once opened. */}
        {open ? (
          <div className="mt-2">
            <LazyTextProse text={model.content} />
          </div>
        ) : null}
      </details>
    </MarkerRow>
  )
}
