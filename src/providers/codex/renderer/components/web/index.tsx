import type { CodexWebModel } from '@providers/codex/renderer/adapters/web'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { SafeMarkdownLink } from '@renderer/features/rendered-content/SafeMarkdownLink'

export function CodexWebRow({ model }: { model: CodexWebModel }) {
  const title = model.operation === 'search'
    ? 'Search web'
    : model.operation === 'open-page'
      ? 'Open web page'
      : 'Find on web page'
  return (
    <MarkerRow marker="⏺">
      <div className="flex flex-wrap items-baseline gap-x-2 min-w-0 text-[13px] leading-[1.65]">
        <span className="text-accent font-semibold flex-shrink-0">{title}</span>
        {model.url ? (
          <SafeMarkdownLink href={model.url} className="text-ink-dim truncate min-w-0">
            {model.label}
          </SafeMarkdownLink>
        ) : (
          <span className="text-ink-dim truncate min-w-0" title={model.label}>
            {model.label}
          </span>
        )}
        {model.operation === 'find-in-page' && model.url ? (
          <SafeMarkdownLink href={model.url} className="text-muted text-[11px] truncate min-w-0">
            {model.url}
          </SafeMarkdownLink>
        ) : null}
        {model.status ? (
          <span className="text-muted text-[10px] uppercase tracking-wider">
            {model.status.replace(/_/g, ' ')}
          </span>
        ) : null}
      </div>
    </MarkerRow>
  )
}
