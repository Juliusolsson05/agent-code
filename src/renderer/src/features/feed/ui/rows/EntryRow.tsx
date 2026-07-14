import { memo } from 'react'

import {
  isCompactBoundaryEntry,
  isCompactSummaryEntry,
  type Entry,
} from '@shared/types/transcript'

import { CompactBoundaryRow } from '@renderer/features/feed/ui/rows/CompactBoundaryRow'
import { CompactSummaryRow } from '@renderer/features/feed/ui/rows/CompactSummaryRow'
import { taskNotificationFromEntry } from '@renderer/session-runtime/taskNotification'
import { TaskNotificationRow } from '@renderer/features/feed/ui/rows/TaskNotificationRow'
import { SystemRow } from '@renderer/features/feed/ui/rows/SystemRow'

// Memoized: entry objects are stable across store updates (we append,
// never mutate), so shallow compare by entry reference skips re-render
// for every row that didn't itself change.
//
// This dispatcher now owns ONLY entry-level system products. Ordinary
// conversation content is flattened by projectFeedPresentation so its tools can
// converge with live semantic calls under one stable OperationRow. Keeping a
// conversation fallback here would silently resurrect the old Block.tsx
// dispatch ladder the rewrite deliberately removed.
export const EntryRow = memo(function EntryRow({ entry }: { entry: Entry }) {
  if (isCompactBoundaryEntry(entry)) {
    return <CompactBoundaryRow />
  }
  if (isCompactSummaryEntry(entry)) {
    return <CompactSummaryRow entry={entry} />
  }
  // Task-notification carrier rows must never paint as user bubbles. The
  // projector sends them here before flattening conversation blocks so an
  // orphan notification retains its purpose-built fallback.
  const notification = taskNotificationFromEntry(entry)
  if (notification) {
    return <TaskNotificationRow notification={notification} />
  }
  return <SystemRow entry={entry} />
})
