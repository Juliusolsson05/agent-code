// Barrel for the feed's semantic-streaming components.
//
// The block-level rows (SemanticLiveBlockRow / SemanticCollapsedActivityRow)
// are consumed by Feed.tsx directly since the #491 un-collapse; the rest are here because they're addressable from
// WorkIndicator / debug surfaces and from each other through this
// barrel. Keeping Feed's import surface to one module means the
// whole semantic section can grow/shrink without Feed having to
// track per-file paths.

export { SemanticLiveBlockRow } from '@renderer/features/feed/ui/semantic/BlockRow'
export { SemanticCollapsedActivityRow } from '@renderer/features/feed/ui/semantic/CollapsedActivityRow'
export { buildSemanticRenderUnits } from '@renderer/features/feed/ui/semantic/renderUnits'
export type { SemanticRenderUnit } from '@renderer/features/feed/ui/semantic/types'
