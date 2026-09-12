import { relativeTime } from '@renderer/lib/relativeTime'

// The prompt list behind View Prompts and Rewind to Prompt. Uncapped on
// purpose (the user, 2026-09-11: "capping the view prompts command is just
// pure stupid"): a few hundred rows of one-line cards render fine without
// virtualisation, and a cap silently hid the prompt the user was looking for.
// Relative time is the primary label because "3h ago" is how people remember
// their own afternoon; the absolute time stays on hover.

export function formatPromptTime(timestamp: number | null): { relative: string; absolute: string | null } {
  if (timestamp === null || !Number.isFinite(timestamp)) return { relative: 'unknown time', absolute: null }
  return {
    relative: relativeTime(timestamp),
    absolute: new Date(timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
  }
}

export function PromptList({ prompts, selectedIndex = null, onSelect, onHover, emptyMessage }: {
  /** Newest first: row 0 is numbered `prompts.length`, the last row `#1`. */
  prompts: ReadonlyArray<{ text: string; timestamp: number | null }>
  selectedIndex?: number | null
  onSelect?: (index: number) => void
  onHover?: (index: number) => void
  emptyMessage: string
}) {
  if (prompts.length === 0) return <div className="py-8 text-center text-[12px] text-muted">{emptyMessage}</div>
  return (
    <ul className="flex flex-col gap-3" role="list">
      {prompts.map((prompt, index) => {
        const time = formatPromptTime(prompt.timestamp)
        const selected = selectedIndex === index
        return (
          <li
            key={`${prompt.timestamp ?? 'unknown'}:${index}`}
            role="listitem"
            aria-selected={onSelect ? selected : undefined}
            data-prompt-index={index}
            onClick={onSelect ? () => onSelect(index) : undefined}
            onMouseEnter={onHover ? () => onHover(index) : undefined}
            className={`rounded-slab border px-3 py-3 ${selected ? 'border-accent bg-row-selected-bg' : 'border-border bg-canvas/70'} ${onSelect ? 'cursor-pointer' : ''}`}
          >
            <div className="flex items-center justify-between gap-3 text-[10px] uppercase tracking-[0.12em] text-muted">
              <span>#{prompts.length - index}</span>
              <span title={time.absolute ?? undefined}>{time.relative}</span>
            </div>
            <div className="mt-2 whitespace-pre-wrap break-words text-[12px] leading-5 text-ink">{prompt.text}</div>
          </li>
        )
      })}
    </ul>
  )
}
