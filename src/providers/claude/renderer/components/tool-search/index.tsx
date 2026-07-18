import type { ClaudeToolSearchModel } from '@providers/claude/renderer/adapters/readSearch'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'

export function ClaudeToolSearchRow({ model }: { model: ClaudeToolSearchModel }) {
  return (
    <MarkerRow marker="⏺">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0 text-[13px] leading-[1.65]">
        <span className="text-accent font-semibold flex-shrink-0">Search tools</span>
        <span className="font-code text-[12px] text-ink-dim truncate min-w-0" title={model.query}>
          {model.query}
        </span>
        {model.maxResults !== null ? (
          <span className="text-muted text-[11px] flex-shrink-0">max {model.maxResults}</span>
        ) : null}
      </div>
    </MarkerRow>
  )
}
