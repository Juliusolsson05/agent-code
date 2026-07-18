import type { ProviderOperationDecision } from '@shared/types/providerConfig'
import type { RenderShapeLifecycle, RenderShapePlane } from '@shared/types/renderShapes'

export type RenderDebugTraceStep = {
  id: string
  condition: string
  outcome: string
  evidence?: unknown
}

/** The data captured at the renderer decision seam. DOM data is deliberately
 * absent: the inspector snapshots the exact clicked Element at click time, so
 * a later React commit cannot make the copied HTML disagree with what received
 * the red outline. */
export type RenderDebugSnapshot = {
  sourcePlane: RenderShapePlane | 'feed-entry' | 'feed-semantic' | 'feed-chrome'
  lifecycle: RenderShapeLifecycle | 'visible'
  eventType: string
  input: unknown
  /** Payload observed by the structural-shape catalog. This can differ from
   * `input`: operation dispatch receives {toolUse,result,...}, while the shape
   * observer fingerprints the individual provider block. */
  shapePayload?: unknown
  pairedResult?: unknown
  normalizedModel?: unknown
  component?: {
    name: string | null
    sourceHint?: string
  }
  decision?: ProviderOperationDecision
  routingTrace?: RenderDebugTraceStep[]
}

export type RenderDebugSelection = {
  selectedAt: number
  selectedElement: Element
  selectedHtml: string
  boundaryHtml: string | null
  boundaryId: string | null
  snapshot: RenderDebugSnapshot | null
  domPath: string
}
