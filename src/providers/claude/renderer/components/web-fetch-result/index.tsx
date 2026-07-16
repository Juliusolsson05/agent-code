import { useState } from 'react'

import type { ClaudeWebFetchResultModel } from '@providers/claude/renderer/adapters/web'
import { SafeMarkdownLink } from '@renderer/features/rendered-content/SafeMarkdownLink'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { TextProse } from '@renderer/features/feed/ui/markdown'

export function ClaudeWebFetchResultRow({ model }: { model: ClaudeWebFetchResultModel }) {
  const [open, setOpen] = useState(false)
  const count = model.lineCountTruncated ? `≥${model.lineCount}` : String(model.lineCount)
  const noun = model.lineCount === 1 && !model.lineCountTruncated ? 'line' : 'lines'

  return (
    <MarkerRow marker="⎿" tone="muted">
      <details
        className="text-[12px] leading-[1.55] text-ink-dim"
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="cursor-pointer select-none">
          Fetched <span className="text-ink font-semibold">{count}</span> {noun} from{' '}
          <SafeMarkdownLink href={model.url} title={model.urlLabel}>
            {model.urlLabel}
          </SafeMarkdownLink>
        </summary>
        {/* Native details alone does not defer React work. Web results are
            provider text and may be large Markdown, so mounting TextProse only
            after the user opens the row is the actual parser/DOM boundary. */}
        {open ? (
          <div className="mt-2">
            <TextProse text={model.content} />
          </div>
        ) : null}
      </details>
    </MarkerRow>
  )
}
