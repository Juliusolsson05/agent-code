import type { QueuedMessage } from '@renderer/workspace/workspaceState'

// Pending queue strip. Renders only when the provider's local queue
// has items: prompts accepted while the agent is still generating a
// previous turn. This intentionally lives outside the scrollable
// transcript Feed. A queued prompt is pending input, not durable
// conversation history; painting it as a Feed row makes the UI look
// like a strange half-sent user message and was the failure captured
// in the 2026-05-20 "COMPLETELY FUCKED UI" manual debug bundle.
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
