import type { ClaudeWebFetchModel } from '@providers/claude/renderer/adapters/web'
import { SafeMarkdownLink } from '@renderer/features/rendered-content/SafeMarkdownLink'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'

export function ClaudeWebFetchRow({ model }: { model: ClaudeWebFetchModel }) {
  return (
    <MarkerRow marker="⏺">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0 text-[13px] leading-[1.65]">
        <span className="text-accent font-semibold flex-shrink-0">Fetch</span>
        <SafeMarkdownLink
          href={model.url}
          className="font-code text-[12px] text-ink-dim hover:text-ink underline decoration-ink-faint truncate min-w-0"
          title={model.urlLabel}
        >
          {model.urlLabel}
        </SafeMarkdownLink>
        <span className="text-muted text-[11px] truncate min-w-0" title={model.prompt}>
          {model.prompt}
        </span>
      </div>
    </MarkerRow>
  )
}
