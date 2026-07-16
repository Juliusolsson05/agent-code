import type { AgentProviderKind } from '@shared/types/providerKind'
import type {
  ContentBlock,
  Entry,
  ToolResultBlock,
  ToolUseBlock,
} from '@shared/types/transcript'

import type { FeedRenderItemOrder } from '@renderer/features/feed/model/renderModel'
import type {
  SemanticLiveBlock,
  SemanticToolCallSnapshot,
  StreamPhase,
} from '@renderer/session-runtime/state'
import type { SemanticRenderUnit } from '@renderer/features/feed/ui/semantic/types'

/**
 * User-intent families are deliberately broader than provider tool names.
 *
 * WHY: Claude, Codex, and OpenCode use different wire vocabulary for the same
 * visible work, and that vocabulary changes more often than the product model
 * does.  Keeping this finite union at the presentation boundary lets React
 * answer "what is the agent doing?" without teaching every component about
 * every provider spelling.  `generic` is intentionally total; an unfamiliar
 * tool must become a useful, inspectable row rather than disappear.
 */
export type OperationFamily =
  | 'preparing'
  | 'file-change'
  | 'command'
  | 'terminal-interaction'
  | 'read'
  | 'search'
  | 'web'
  | 'collaboration'
  | 'task-plan'
  | 'question'
  | 'mcp'
  | 'image'
  | 'notebook'
  | 'code-intelligence'
  | 'skill-workflow'
  | 'workspace'
  | 'generic'

export type OperationLifecycle =
  | 'preparing'
  | 'streaming'
  | 'running'
  | 'complete'
  | 'error'
  | 'denied'
  | 'cancelled'

export type OperationClassification = {
  family: OperationFamily
  confidence: 'hint' | 'structural' | 'final'
  /** Human-readable evidence is exported into RENDER debug receipts. */
  evidence: string
  /** Unified Codex exec may reveal a nested tool name before its wrapper seals. */
  displayToolName?: string
  /** Completed nested object arguments, when the narrow wrapper scanner has them. */
  structuredInput?: Record<string, unknown> | null
}

/**
 * Both transport planes may describe one operation during the hand-off from a
 * live semantic block to a committed transcript block.  We retain both pieces
 * of evidence in one VM instead of choosing a plane in the projector.  The UI
 * can prefer the richest evidence while React keeps one operation identity.
 */
export type OperationVM = {
  id: string
  provider: AgentProviderKind
  family: OperationFamily
  classification: OperationClassification
  lifecycle: OperationLifecycle
  toolName: string
  correlationId: string
  sourceKeys: string[]
  committedToolUse: ToolUseBlock | null
  /**
   * Every committed result event, in visible source order.
   *
   * WHY this is plural even though the transcript index is singular: Codex can
   * emit more than one durable result for a call (for example patch_apply_end
   * followed by custom_tool_call_output). Collapsing those into a Map's last
   * value loses the patch diff/error while receipts still claim both sources
   * were absorbed. The singular field below remains the preferred compatibility
   * view for the mature artifact adapters; this array is the lossless evidence.
   */
  committedResults: ToolResultBlock[]
  /** Preferred result for single-result artifact adapters. */
  committedResult: ToolResultBlock | null
  liveBlock: SemanticLiveBlock | null
  liveToolState: SemanticToolCallSnapshot | null
  /** Every separate Responses output item, in source order. */
  liveOutputs: unknown[]
  /** Preferred/latest output compatibility view. */
  liveOutput: unknown
  /** Every truly unmatched committed result, in source order. */
  standaloneResults: ToolResultBlock[]
  /** Preferred unmatched-result compatibility view. */
  standaloneResult: ToolResultBlock | null
}

export type PresentationNodeBase = {
  id: string
  sourceKeys: string[]
  order: FeedRenderItemOrder
  /** Committed entry uuid or semantic turn id. Presentation-only grouping may
   *  use this, but it must never become an ownership or ordering key. */
  sourceGroupId: string | null
  entryUuid: string | null
  entryOrdinal: number | null
}

export type PresentationNode =
  | (PresentationNodeBase & {
      kind: 'message'
      role: 'user' | 'assistant'
      text: string
      streaming: boolean
      citations: unknown[]
    })
  | (PresentationNodeBase & {
      kind: 'thinking'
      text: string
      streaming: boolean
      redacted: boolean
    })
  | (PresentationNodeBase & {
      kind: 'image'
      role: 'user' | 'assistant'
      block: ContentBlock
    })
  | (PresentationNodeBase & {
      kind: 'operation'
      operation: OperationVM
    })
  | (PresentationNodeBase & {
      kind: 'operation-group'
      family: 'collaboration'
      operationIds: string[]
      toolUseIds: string[]
    })
  | (PresentationNodeBase & {
      kind: 'activity'
      unit: Extract<SemanticRenderUnit, { type: 'collapsed_activity' }>
    })
  | (PresentationNodeBase & {
      kind: 'system'
      system:
        | { type: 'entry'; entry: Entry }
        | {
            type: 'work'
            phase: StreamPhase
            toolName: string | null
            toolUseId: string | null
          }
        | { type: 'empty'; provider: AgentProviderKind }
    })
  | (PresentationNodeBase & {
      kind: 'fallback'
      label: string
      value: unknown
      role: 'user' | 'assistant' | null
    })

export type ProjectionReceipt = {
  sourceKey: string
  disposition: 'painted' | 'absorbed' | 'fallback'
  targetIds: string[]
  reason: string
}

export type PresentationProjection = {
  nodes: PresentationNode[]
  receipts: ProjectionReceipt[]
}
