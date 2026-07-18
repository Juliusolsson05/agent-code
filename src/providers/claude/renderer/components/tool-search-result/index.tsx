import type { ClaudeToolSearchResultModel } from '@providers/claude/renderer/adapters/readSearch'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'

export function ClaudeToolSearchResultRow({ model }: { model: ClaudeToolSearchResultModel }) {
  const count = model.toolsTruncated ? `≥${model.tools.length}` : String(model.tools.length)
  const noun = model.tools.length === 1 && !model.toolsTruncated ? 'tool' : 'tools'

  return (
    <MarkerRow marker="⎿" tone="muted">
      <details className="text-[12px] leading-[1.55] text-ink-dim">
        <summary className="cursor-pointer select-none">
          Found <span className="text-ink font-semibold">{count}</span> {noun}
        </summary>
        <ul className="mt-1.5 flex flex-col gap-0.5 list-none p-0" aria-label="Matched tools">
          {model.tools.map((tool, index) => (
            // Duplicate tool references are preserved because they are
            // provider evidence, not treated as React identity. The index is
            // therefore the only stable key for this ordered result list.
            <li key={`${index}:${tool}`} className="font-code text-[12px] text-ink-dim break-all">
              {tool}
            </li>
          ))}
          {model.tools.length === 0 ? (
            <li className="text-muted italic">No matching tools</li>
          ) : null}
          {model.toolsTruncated ? (
            <li className="text-muted italic">More tool references were omitted</li>
          ) : null}
        </ul>
      </details>
    </MarkerRow>
  )
}
