import { memo } from 'react'

import {
  isCompactBoundaryEntry,
  isCompactSummaryEntry,
  isConversationEntry,
  type Entry,
} from '@shared/types/transcript'

import { CompactBoundaryRow } from './CompactBoundaryRow'
import { CompactSummaryRow } from './CompactSummaryRow'
import { ConversationRow } from './ConversationRow'
import { SystemRow } from './SystemRow'

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
    return <ConversationRow entry={entry} />
  }
  return <SystemRow entry={entry} />
})
