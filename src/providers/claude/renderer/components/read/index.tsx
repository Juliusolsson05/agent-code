import { useContext } from 'react'

import type { ClaudeReadModel } from '@providers/claude/renderer/adapters/readSearch'
import { CodeRenderContext } from '@renderer/features/feed/context'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { formatToolFilePath } from '@shared/paths/displayPath'

export function ClaudeReadRow({ model }: { model: ClaudeReadModel }) {
  const { workspaceRoot } = useContext(CodeRenderContext)
  const displayPath = formatToolFilePath(model.path, workspaceRoot)
  const range =
    model.offset !== null || model.limit !== null
      ? [
          model.offset !== null ? `offset ${model.offset}` : null,
          model.limit !== null ? `limit ${model.limit}` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : null

  return (
    <MarkerRow marker="⏺">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0 text-[13px] leading-[1.65]">
        <span className="text-accent font-semibold flex-shrink-0">Read</span>
        <span className="font-code text-[12px] text-ink-dim truncate min-w-0" title={model.path}>
          {displayPath}
        </span>
        {range ? <span className="text-muted text-[11px] flex-shrink-0">{range}</span> : null}
      </div>
    </MarkerRow>
  )
}
