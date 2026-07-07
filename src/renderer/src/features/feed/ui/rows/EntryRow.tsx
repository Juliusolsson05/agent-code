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
import { taskNotificationFromEntry } from '@renderer/features/feed/lib/taskNotification'
import { TaskNotificationRow } from '@renderer/features/feed/ui/rows/TaskNotificationRow'
import { SystemRow } from '@renderer/features/feed/ui/rows/SystemRow'

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
  if (isCompactBoundaryEntry(entry)) {
    return <CompactBoundaryRow />
  }
  if (isCompactSummaryEntry(entry)) {
    return <CompactSummaryRow entry={entry} />
  }
  if (isConversationEntry(entry)) {
    // Task-notification carrier rows must never paint as user bubbles
    // (P2b). Entries whose parent Task row is visible never reach here
    // (renderModel skips them); this branch is the parentless fallback.
    const notification = taskNotificationFromEntry(entry)
    if (notification) {
      return <TaskNotificationRow notification={notification} />
    }
    return <ConversationRow entry={entry} />
  }
  return <SystemRow entry={entry} />
})
