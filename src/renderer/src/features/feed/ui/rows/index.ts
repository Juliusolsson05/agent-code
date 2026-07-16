// Barrel for the feed's row components.
//
// Feed.tsx imports only the lazy wrapper through this barrel. Conversation and
// tool dispatch no longer live in rows/: the pure presentation projector and
// OperationRow are the single path for both live and committed evidence.

export { EAGER_TAIL, LazyEntry } from '@renderer/features/feed/ui/rows/LazyEntry'
export { EntryRow } from '@renderer/features/feed/ui/rows/EntryRow'
export { CompactBoundaryRow } from '@renderer/features/feed/ui/rows/CompactBoundaryRow'
export { CompactSummaryRow } from '@renderer/features/feed/ui/rows/CompactSummaryRow'
export { SystemRow } from '@renderer/features/feed/ui/rows/SystemRow'
export { ImageBlockRow } from '@renderer/features/feed/ui/rows/ImageBlockRow'
export { UserBand } from '@renderer/features/feed/ui/rows/primitives'
