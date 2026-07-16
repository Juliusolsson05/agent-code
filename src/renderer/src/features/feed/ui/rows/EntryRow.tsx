import { memo } from 'react'

import {
  isCompactBoundaryEntry,
  isCompactSummaryEntry,
  isConversationEntry,
  type Entry,
} from '@shared/types/transcript'

import { CompactBoundaryRow } from '@renderer/features/feed/ui/rows/CompactBoundaryRow'
import { CompactSummaryRow } from '@renderer/features/feed/ui/rows/CompactSummaryRow'
import { ConversationRow } from '@renderer/features/feed/ui/rows/ConversationRow'
import { taskNotificationFromEntry } from '@renderer/session-runtime/taskNotification'
import { TaskNotificationRow } from '@renderer/features/feed/ui/rows/TaskNotificationRow'
import { SystemRow } from '@renderer/features/feed/ui/rows/SystemRow'
import { observeRenderShape } from '@renderer/features/feed/evidence/observer'
import { useRenderShapeCapture } from '@renderer/features/feed/evidence/RenderShapeCaptureContext'
import { GENERIC_OUTCOME, specializedOutcome } from '@renderer/features/feed/evidence/outcome'

// Memoized: entry objects are stable across store updates (we append,
// never mutate), so shallow compare by entry reference skips re-render
// for every row that didn't itself change.
//
// This is the per-entry dispatcher called by Feed's render loop. It
// picks the right row component based on the entry's shape. Order
// matters slightly: compact-boundary and compact-summary entries are
// also "conversation-like" in the broad sense, so the type-guard
// checks happen in most-specific-first order.
export const EntryRow = memo(function EntryRow({ entry }: { entry: Entry }) {
  const capture = useRenderShapeCapture()
  // Transcript-entry plane sighting (Phase 2, PR #555) — records which
  // ENTRY KINDS flow through the renderer and where each routed. The
  // conversation branch is deliberately NOT sighted here: a conversation
  // entry is a container whose content blocks are each observed at the
  // Block dispatcher with far better outcome fidelity; sighting the
  // container too would only double-count. eventType carries the entry
  // type plus system subtype (`system:turn_duration` style) because subtype
  // is the render-relevant discriminator for system entries.
  const sight = (outcome: import('@shared/types/renderShapes').RenderOutcome): void => {
    if (!capture) return
    const subtype = (entry as { subtype?: unknown }).subtype
    observeRenderShape({
      sessionId: capture.sessionId,
      provider: capture.provider,
      plane: 'transcript-entry',
      lifecycle: 'durable',
      eventType: typeof subtype === 'string' ? `${entry.type}:${subtype}` : entry.type,
      payload: entry,
      outcome,
    })
  }
  if (isCompactBoundaryEntry(entry)) {
    sight(specializedOutcome('shared.compact-boundary-row'))
    return <CompactBoundaryRow />
  }
  if (isCompactSummaryEntry(entry)) {
    sight(specializedOutcome('shared.compact-summary-row'))
    return <CompactSummaryRow entry={entry} />
  }
  if (isConversationEntry(entry)) {
    // Task-notification carrier rows must never paint as user bubbles
    // (P2b). Entries whose parent Task row is visible never reach here
    // (renderModel skips them); this branch is the parentless fallback.
    const notification = taskNotificationFromEntry(entry)
    if (notification) {
      sight(specializedOutcome('shared.task-notification-row'))
      return <TaskNotificationRow notification={notification} />
    }
    return <ConversationRow entry={entry} />
  }
  // SystemRow is the muted low-signal fallback for hooks/permission-mode/
  // snapshot/unknown entries — the generic outcome by definition.
  sight(GENERIC_OUTCOME)
  return <SystemRow entry={entry} />
})
