import type { Conversation } from '@shared/conversations/types'
import { relativeTime } from '@renderer/lib/relativeTime'
import { providerGlyph } from '@renderer/features/workspace/lib/sessionDisplay'

// The one row every picker renders. It makes no naming decision: label and
// provenance come from the catalog; a fallback label is italic so the user
// knows they are looking at a stand-in (#701's requirement, now possible).
export function ConversationRow({ row, selected, index, onHover, onSelect }: {
  row: Conversation
  selected: boolean
  index: number
  onHover: () => void
  onSelect: () => void
}) {
  const fallback = row.labelSource === 'cwd' || row.labelSource === 'native-id'
  const label = row.match?.field === 'label' ? highlight(row.label, row.match.start, row.match.end) : row.label
  return (
    <div
      role="option"
      aria-selected={selected}
      data-conversation-index={index}
      onMouseEnter={onHover}
      onClick={onSelect}
      className={`cursor-pointer border-b border-border px-3 py-2 last:border-b-0 ${selected ? 'bg-row-selected-bg text-row-selected-fg' : 'text-ink-dim hover:bg-row-hover-bg'} ${row.available ? '' : 'opacity-60'}`}
    >
      <div className="flex items-center gap-2 text-[12px]">
        <span className="w-4 text-center font-semibold text-accent select-none">{providerGlyph(row.provider)}</span>
        <span className={`min-w-0 flex-1 truncate ${fallback ? 'italic text-muted' : 'text-ink'}`}>{label}</span>
        {row.agentName && <span className="rounded-slab border border-border px-1.5 text-[10px] text-ink-dim">{row.agentName}</span>}
        {row.kind !== 'user' && <span className="text-[10px] uppercase tracking-wider text-muted">{row.kind}</span>}
      </div>
      <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted">
        <span>{relativeTime(row.lastUserActivityAt)}</span>
        {row.worktree && <span className="truncate">{row.worktree}</span>}
        {!row.worktree && row.gitBranch && <span className="truncate">{row.gitBranch}</span>}
        {row.promptCount !== null && <span>{row.promptCount} {row.promptCount === 1 ? 'prompt' : 'prompts'}</span>}
        {!row.available && <span>unavailable</span>}
        {row.match && row.match.field !== 'label' && (
          <span className="min-w-0 truncate text-ink-dim">› {highlight(row.match.text, row.match.start, row.match.end)}</span>
        )}
      </div>
    </div>
  )
}

function highlight(text: string, start: number, end: number) {
  return (
    <>
      {text.slice(0, start)}
      <span className="bg-accent/25 text-accent">{text.slice(start, end)}</span>
      {text.slice(end)}
    </>
  )
}
