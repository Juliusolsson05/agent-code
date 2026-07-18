import type { ClaudeWebSearchModel } from '@providers/claude/renderer/adapters/web'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'

export function ClaudeWebSearchRow({ model }: { model: ClaudeWebSearchModel }) {
  return (
    <MarkerRow marker="⏺">
      <div className="flex items-baseline gap-x-2 min-w-0 text-[13px] leading-[1.65]">
        <span className="text-accent font-semibold flex-shrink-0">Search web</span>
        <span className="text-ink-dim truncate min-w-0" title={model.query}>
          {model.query}
        </span>
      </div>
    </MarkerRow>
  )
}
