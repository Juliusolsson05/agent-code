import type { QueuedMessage } from '@renderer/session-runtime/state'
import type { AgentProviderKind } from '@shared/types/providerKind'
import {
  parseTaskNotification,
  taskNotificationStatusKind,
} from '@providers/claude/renderer/adapters/taskNotification'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { PagedTextViewer } from '@renderer/lib/text/PagedTextViewer'
import { useEffect, useId, useMemo, useState } from 'react'

// The browsing surface must stay cheap even when somebody pastes a whole
// design document as their next prompt. CSS clipping alone still leaves the
// browser shaping and measuring the complete text node. Keep only a bounded,
// two-line summary in the lane; the exact source is materialized on demand
// in QueuedPromptDialog, whose PagedTextViewer also bounds DOM size.
const PREVIEW_SCAN_CHARACTERS = 320
const PREVIEW_CHARACTERS = 180

function queuedPromptPreview(content: string): string {
  const scanned = content.slice(0, PREVIEW_SCAN_CHARACTERS)
  // Preserve line boundaries because they are the only cheap hint that a
  // queued item contains pasted instructions or code. Horizontal whitespace
  // is normalized so an indented block cannot make the compact lane look
  // empty; the exact indentation remains untouched in the dialog.
  const compact = scanned
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    // WHY repeated blank lines collapse in the lane but not the dialog:
    // line-clamp counts an empty Markdown separator as a visible row, which
    // otherwise turns the promised two-line summary into one line plus empty
    // space. The exact source (including every blank line) remains untouched
    // in PagedTextViewer.
    .replace(/\n{2,}/g, '\n')
    .trim()
  const scanContainsAllSource = scanned.length === content.length
  if (scanContainsAllSource && compact.length <= PREVIEW_CHARACTERS) {
    return compact
  }
  return `${compact.slice(0, PREVIEW_CHARACTERS - 1).trimEnd()}…`
}

function QueuedPromptDialog({
  message,
  position,
  total,
  onClose,
}: {
  message: QueuedMessage | null
  position: number
  total: number
  onClose: () => void
}) {
  return (
    <Dialog
      open={message !== null}
      onOpenChange={open => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        className="flex max-h-[82vh] w-[min(760px,92vw)] flex-col overflow-hidden"
        showCloseButton
      >
        <DialogHeader>
          <DialogTitle>Queued prompt</DialogTitle>
          <DialogDescription>
            {position} of {total} · queued for delivery
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {message ? (
            <PagedTextViewer
              source={message.content}
              className="text-ink [overflow-wrap:anywhere]"
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// Pending queue strip. Renders only when the provider's local queue
// has items: prompts accepted while the agent is still generating a
// previous turn. This intentionally lives outside the scrollable
// transcript Feed. A queued prompt is pending input, not durable
// conversation history; painting it as a Feed row makes the UI look
// like a strange half-sent user message and was the failure captured
// in the 2026-05-20 "COMPLETELY FUCKED UI" manual debug bundle.
export function QueueStrip({
  provider,
  queuedMessages,
}: {
  provider: AgentProviderKind
  queuedMessages: QueuedMessage[]
}) {
  const listId = useId()
  const [collapsed, setCollapsed] = useState(false)
  const [selectedPrompt, setSelectedPrompt] = useState<QueuedMessage | null>(null)
  const displayItems = useMemo(() => queuedMessages.map(message => {
    // WHY content sniffing is Claude-only: task notifications are a Claude
    // provider protocol. A Codex/OpenCode user may paste the same XML while
    // discussing or debugging it; treating that real prompt as a notification
    // would hide the exact-content button.
    const notification = provider === 'claude'
      ? parseTaskNotification(message.content)
      : null
    return {
      message,
      notification,
      preview: notification ? null : queuedPromptPreview(message.content),
    }
  }), [provider, queuedMessages])

  const selectedIndex = selectedPrompt === null
    ? -1
    : queuedMessages.findIndex(message =>
        message.timestamp === selectedPrompt.timestamp &&
        message.content === selectedPrompt.content,
      )
  const selectedMessage = selectedIndex >= 0 ? queuedMessages[selectedIndex] ?? null : null

  useEffect(() => {
    if (selectedPrompt === null || selectedMessage !== null) return
    // WHY controlled Radix dialogs do not call onOpenChange when their `open`
    // prop becomes false because external queue state removed the item. Clear
    // our snapshot explicitly so a large dequeued prompt is not retained by
    // the pane and a replayed queue-operation cannot reopen it later.
    setSelectedPrompt(null)
  }, [selectedMessage, selectedPrompt])

  if (queuedMessages.length === 0) return null

  return (
    <>
      <section
        className="flex min-w-0 flex-shrink-0 flex-col overflow-hidden border-t border-border bg-surface [max-height:clamp(32px,30%,160px)]"
        role="group"
        aria-label="queued messages"
      >
        <button
          type="button"
          className="flex min-h-8 flex-none items-center justify-between gap-3 px-3 text-left text-[10px] uppercase tracking-wider text-muted hover:bg-surface-hi hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          aria-controls={listId}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(current => !current)}
        >
          <span className="min-w-0 truncate">{queuedMessages.length} queued</span>
          <span className="shrink-0 normal-case tracking-normal" aria-hidden="true">
            {collapsed ? '▴ show' : '▾ hide'}
          </span>
        </button>

        {!collapsed ? (
          <ul
            id={listId}
            aria-label="queued prompt list"
            className="m-0 min-h-0 list-none overflow-y-auto overscroll-contain border-t border-border px-3 py-1"
          >
            {displayItems.map(({ message: q, notification, preview }, index) => {
              // P2b display-only mapping (plan D1 — no queue-model change): a
              // task-notification parked pre-delivery renders as a one-line
              // chip, never the raw XML with the child's whole report inside
              // (the 2026-06-29 "agent output buried" burial surface).
              if (notification) {
                const kind = taskNotificationStatusKind(notification)
                return (
                  <li
                    key={`${q.timestamp}:${index}`}
                    className="flex min-w-0 items-start gap-2 py-0.5 text-[12px] leading-[1.5] text-ink-dim"
                  >
                    <span className="flex-shrink-0 select-none opacity-60" aria-hidden="true">
                      {kind === 'error' ? '✗' : '✓'}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {/*
                        WHY no raw `status` append (2026-07-07 bundle
                        debug-bundles/manual/2026-07-07T13-17-20-472-5b19529f
                        "completed agents renders as queued"): the summary already
                        reads `Agent "X" finished`, and appending the raw <status>
                        produced the nonsense "finished completed — delivering to
                        agent…" the user screenshotted. The ✓/✗ glyph (driven by
                        taskNotificationStatusKind) already carries the outcome, so
                        the summary alone is the human-readable line.
                      */}
                      {notification.summary ?? notification.taskId ?? 'background task'} —
                      delivering to agent…
                    </span>
                  </li>
                )
              }

              return (
                <li key={`${q.timestamp}:${index}`} className="min-w-0 py-0.5">
                  <button
                    type="button"
                    className="flex w-full min-w-0 items-center gap-2 text-left text-[12px] leading-[1.5] text-ink-dim hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                    onClick={() => setSelectedPrompt(q)}
                    aria-label={`View queued prompt: ${preview ?? ''}`}
                  >
                    <span
                      className="flex-shrink-0 select-none text-accent opacity-60"
                      aria-hidden="true"
                    >
                      ❯
                    </span>
                    {/* WHY this is a two-line, character-bounded preview instead
                        of the full prompt with CSS overflow: the lane competes
                        directly with Feed and Composer for a pane's height, and
                        CSS clipping still makes Chromium shape the entire text
                        node. Exact whitespace and every byte remain available
                        through the dialog, but browsing N queued prompts stays
                        constant-height and cheap even for pasted documents. */}
                    <span className="min-w-0 flex-1 line-clamp-2 whitespace-pre-wrap font-code [overflow-wrap:anywhere]">
                      {preview || '(empty prompt)'}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted" aria-hidden="true">
                      view
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        ) : null}
      </section>

      <QueuedPromptDialog
        message={selectedMessage}
        position={selectedIndex + 1}
        total={queuedMessages.length}
        onClose={() => setSelectedPrompt(null)}
      />
    </>
  )
}
