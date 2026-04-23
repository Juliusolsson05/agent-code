// Barrel for the feed's row components.
//
// Feed.tsx imports EntryRow + LazyEntry + EAGER_TAIL directly; the
// rest of these exports are here because rows cross-reference each
// other through this barrel (EntryRow → Conversation/Compact/System,
// ConversationRow → Block, Block → ImageBlockRow/ToolUseRow/...) and
// keeping the barrel stable means future Feed changes never have to
// update individual per-component paths.

export { EAGER_TAIL, LazyEntry } from '@renderer/features/feed/ui/rows/LazyEntry'
export { EntryRow } from '@renderer/features/feed/ui/rows/EntryRow'
export { ConversationRow } from '@renderer/features/feed/ui/rows/ConversationRow'
export { Block } from '@renderer/features/feed/ui/rows/Block'
export { CompactBoundaryRow } from '@renderer/features/feed/ui/rows/CompactBoundaryRow'
export { CompactSummaryRow } from '@renderer/features/feed/ui/rows/CompactSummaryRow'
export { SystemRow } from '@renderer/features/feed/ui/rows/SystemRow'
export { ImageBlockRow } from '@renderer/features/feed/ui/rows/ImageBlockRow'
export { ToolUseRow } from '@renderer/features/feed/ui/rows/ToolUseRow'
export { ToolResultRow } from '@renderer/features/feed/ui/rows/ToolResultRow'
export { TruncatedOutputRow } from '@renderer/features/feed/ui/rows/TruncatedOutputRow'
export { UserBand, ToolBand } from '@renderer/features/feed/ui/rows/primitives'
