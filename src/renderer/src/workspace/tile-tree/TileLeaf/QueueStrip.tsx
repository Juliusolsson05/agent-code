import type { QueuedMessage } from '@renderer/workspace/workspaceStore'

// Pending queue strip. Renders only when CC's internal message
// queue has items — i.e. the user submitted prompts while CC
// was still generating a previous turn. Lives between Feed and
// composer so it sits in the natural "about to happen" region
// of the screen, and so the user can see their queued text
// without it getting mixed into the feed proper (where it
// would show as either phantom future user rows or as real
// rows that then duplicate themselves when the actual user
// entry materializes in the transcript).
//
// Feature-gated on queuedMessages.length so the strip is
// zero-DOM when nothing is queued — no layout shift for the
// common path. The caller does the length check before
// rendering this component so early-return here would be
// redundant; we still guard because QueueStrip might be called
// directly by a future surface (debug view, storybook) where
// the caller forgets.
export function QueueStrip({
  queuedMessages,
}: {
  queuedMessages: QueuedMessage[]
}) {
  if (queuedMessages.length === 0) return null
  return (
    <div
      className="flex-shrink-0 border-t border-border bg-surface px-5 py-2"
      aria-label="queued messages"
    >
      <div className="text-muted text-[10px] uppercase tracking-wider mb-1 select-none">
        {queuedMessages.length} queued
      </div>
      <ul className="flex flex-col gap-0.5 list-none m-0 p-0">
        {queuedMessages.map(q => (
          <li
            key={q.timestamp}
            className="flex items-start gap-2 text-[12px] leading-[1.5] text-ink-dim"
          >
            <span
              className="text-accent flex-shrink-0 select-none opacity-60"
              aria-hidden="true"
            >
              ❯
            </span>
            <span className="flex-1 min-w-0 break-words font-code">
              {q.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
