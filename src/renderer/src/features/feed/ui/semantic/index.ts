// Barrel for the feed's semantic-streaming components.
//
// Semantic grouping remains upstream of the presentation boundary. Individual
// live blocks no longer have their own React dispatch ladder; the projector
// normalizes them into the same OperationRow as committed transcript blocks.

export { SemanticCollapsedActivityRow } from '@renderer/features/feed/ui/semantic/CollapsedActivityRow'
export { buildSemanticRenderUnits } from '@renderer/features/feed/ui/semantic/renderUnits'
export type { SemanticRenderUnit } from '@renderer/features/feed/ui/semantic/types'
