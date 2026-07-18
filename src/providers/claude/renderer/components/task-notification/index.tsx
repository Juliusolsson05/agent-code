import { memo } from 'react'

import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import {
  taskNotificationStatusKind,
  type TaskNotification,
} from '@providers/claude/renderer/adapters/taskNotification'
import { TextProse } from '@renderer/features/feed/ui/markdown'

/* ---------- Standalone task-notification row ---------- */
//
// Fires ONLY when the notification has no visible parent Task row to join
// (no <tool-use-id> tag, parent outside the loaded window, cross-session
// delivery). The joined case never reaches a row at all — renderModel
// skips those entries pre-LazyEntry so a burst of completions cannot
// build the 48px-spacer wall from the 2026-06-22 bundle.
//
// One compact line, assistant-side, muted — NEVER a user bubble, never
// raw XML (the 06-29 "rendered like a retard" fix). Result markdown
// expands on demand.

export const TaskNotificationRow = memo(function TaskNotificationRow({
  notification,
}: {
  notification: TaskNotification
}) {
  const kind = taskNotificationStatusKind(notification)
  const glyph = kind === 'done' ? '✓' : kind === 'error' ? '✗' : '◐'
  const label = notification.summary ?? notification.taskId ?? 'background task'

  return (
    <MarkerRow marker={glyph} tone="muted">
      <div className="min-w-0 text-[12px] leading-[1.6]">
        <span className={`break-words ${kind === 'error' ? 'text-danger' : 'text-ink-dim'}`}>
          {label}
          {notification.status ? ` · ${notification.status}` : ''}
          {notification.usage ? ` · ${notification.usage}` : ''}
        </span>
        {notification.result && (
          <details className="mt-0.5">
            <summary className="cursor-pointer text-ink-dim select-none text-[11px]">
              result
            </summary>
            <div className="mt-1">
              <TextProse text={notification.result} />
            </div>
          </details>
        )}
        {notification.outputFile && (
          <div className="text-[11px] text-ink-dim font-code break-all" title={notification.outputFile}>
            {notification.outputFile}
          </div>
        )}
      </div>
    </MarkerRow>
  )
})
