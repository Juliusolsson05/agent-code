// Barrel for the feed's semantic-streaming components.
//
// Only SemanticStreamingTurn is consumed by Feed.tsx directly — the
// rest of the exports are here because they're addressable from
// WorkIndicator / debug surfaces and from each other through this
// barrel. Keeping Feed's import surface to one module means the
// whole semantic section can grow/shrink without Feed having to
// track per-file paths.

export { SemanticStreamingTurn } from '@renderer/features/feed/ui/semantic/StreamingTurn'
export { SemanticLiveBlockRow } from '@renderer/features/feed/ui/semantic/BlockRow'
export { SemanticCollapsedActivityRow } from '@renderer/features/feed/ui/semantic/CollapsedActivityRow'
export { SemanticTodoList } from '@renderer/features/feed/ui/semantic/TodoList'
export { buildSemanticRenderUnits } from '@renderer/features/feed/ui/semantic/renderUnits'
export type { SemanticRenderUnit } from '@renderer/features/feed/ui/semantic/types'
