import {
  isCompactBoundaryEntry,
  isCompactSummaryEntry,
  isConversationEntry,
  type ContentBlock,
  type ToolResultBlock,
  type ToolUseBlock,
} from '@shared/types/transcript'
import type { AgentProviderKind } from '@shared/types/providerKind'
import { isAgentSpawnToolName } from '@providers/registry.renderer.capabilities'

import type { FeedRenderItem } from '@renderer/features/feed/model/renderModel'
import { taskNotificationFromEntry } from '@renderer/session-runtime/taskNotification'
import type { SemanticLiveBlock } from '@renderer/session-runtime/state'
import type {
  PresentationNode,
  PresentationNodeBase,
  PresentationProjection,
  ProjectionReceipt,
} from '@renderer/features/feed/presentation/types'
import {
  isSemanticOperationBlock,
  isSemanticOutputBlock,
  mergeOperation,
  operationFromCommitted,
  operationFromLive,
  operationFromStandaloneResult,
  operationId,
  operationCorrelationIdForLive,
} from '@renderer/features/feed/presentation/projectBlock'

export type ProjectFeedPresentationInput = {
  items: readonly FeedRenderItem[]
  provider: AgentProviderKind
  toolUseIndex: ReadonlyMap<string, ToolUseBlock>
  toolResultIndex: ReadonlyMap<string, ToolResultBlock>
}

type OperationNode = Extract<PresentationNode, { kind: 'operation' }>

const SEMANTIC_TEXT_KINDS = new Set(['text', 'message', 'output_text'])

function blockType(block: ContentBlock): string {
  return typeof block.type === 'string' ? block.type : 'unknown'
}

function baseForItem(
  item: FeedRenderItem,
  id: string,
): PresentationNodeBase {
  return {
    id,
    sourceKeys: [item.key],
    order: item.order,
    sourceGroupId:
      item.type === 'entry'
        ? `entry:${typeof item.entry.uuid === 'string' ? item.entry.uuid : item.key}`
        : item.type === 'semantic-block' ||
            item.type === 'semantic-collapsed-activity' ||
            item.type === 'semantic-text'
          ? `turn:${item.turnId}`
          : null,
    entryUuid: item.type === 'entry' && typeof item.entry.uuid === 'string'
      ? item.entry.uuid
      : null,
    entryOrdinal: item.type === 'entry' ? item.entryOrdinal : null,
  }
}

function semanticOutputValue(block: SemanticLiveBlock): unknown {
  if (block.output !== undefined) return block.output
  return block.resultContent
}

function groupAdjacentSpawnOperations(
  nodes: readonly PresentationNode[],
  provider: AgentProviderKind,
): PresentationNode[] {
  const grouped: PresentationNode[] = []
  for (let index = 0; index < nodes.length;) {
    const first = nodes[index]
    if (
      first?.kind !== 'operation' ||
      !first.sourceGroupId ||
      !isAgentSpawnToolName(first.operation.toolName)
    ) {
      if (first) grouped.push(first)
      index += 1
      continue
    }

    let end = index + 1
    while (end < nodes.length) {
      const candidate = nodes[end]
      if (
        candidate?.kind !== 'operation' ||
        candidate.sourceGroupId !== first.sourceGroupId ||
        !isAgentSpawnToolName(candidate.operation.toolName)
      ) break
      end += 1
    }

    const run = nodes.slice(index, end) as OperationNode[]
    if (run.length > 1) {
      const operationIds = run.map(node => node.operation.id)
      const groupId = `operation-group:${provider}:${first.sourceGroupId}:${first.operation.correlationId}`
      grouped.push({
        id: groupId,
        kind: 'operation-group',
        family: 'collaboration',
        sourceKeys: [...new Set(run.flatMap(node => node.sourceKeys))],
        order: first.order,
        sourceGroupId: first.sourceGroupId,
        entryUuid: first.entryUuid,
        entryOrdinal: first.entryOrdinal,
        operationIds,
        toolUseIds: run.map(node => node.operation.correlationId),
      })
    }
    grouped.push(...run)
    index = end
  }
  return grouped
}

/**
 * Pure presentation projection: the ownership ledger remains the sole decider
 * of which source items exist and in what order; this function only turns those
 * clean items into user-facing rows.
 *
 * WHY this is a projection instead of another reducer/store: presentation must
 * be replayable from a debug fixture and must not acquire a second lifecycle.
 * Local mutation below is confined to one invocation and only merges evidence
 * for an already-anchored operation.  No input object or external map is ever
 * changed, and the returned value depends solely on the arguments.
 */
export function projectFeedPresentation({
  items,
  provider,
  toolUseIndex,
  toolResultIndex,
}: ProjectFeedPresentationInput): PresentationProjection {
  const nodes: PresentationNode[] = []
  const receipts: ProjectionReceipt[] = []
  const operationsById = new Map<string, OperationNode>()

  // The session-wide result index intentionally stores one value per tool id,
  // but the visible transcript can contain several result EVENTS for the same
  // operation. If the indexed (usually last) result is already present in the
  // approved item list, do not seed it ahead of source order here; the normal
  // walk below will append every visible result in its actual order. An indexed
  // result outside the loaded/visible window is still valuable pairing evidence
  // and remains eligible for the initial operation.
  const visibleResultIds = new Set<string>()
  for (const item of items) {
    if (item.type !== 'entry' || !isConversationEntry(item.entry)) continue
    const content = item.entry.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (blockType(block) === 'tool_result') {
        visibleResultIds.add((block as ToolResultBlock).tool_use_id)
      }
    }
  }

  const addOperation = (
    item: FeedRenderItem,
    operation: OperationNode['operation'],
    sourceKey: string,
  ): { node: OperationNode; created: boolean } => {
    const existing = operationsById.get(operation.id)
    if (existing) {
      mergeOperation(existing.operation, operation)
      if (!existing.sourceKeys.includes(sourceKey)) existing.sourceKeys.push(sourceKey)
      if (!existing.sourceKeys.includes(item.key)) existing.sourceKeys.push(item.key)
      return { node: existing, created: false }
    }
    // `sourceKeys` is intentionally shared between the shell and VM.  Receipts,
    // React debug attributes, and the expandable source view must never disagree
    // about which live/committed records were folded into this operation.
    if (!operation.sourceKeys.includes(sourceKey)) operation.sourceKeys.push(sourceKey)
    if (!operation.sourceKeys.includes(item.key)) operation.sourceKeys.unshift(item.key)
    const node: OperationNode = {
      ...baseForItem(item, operation.id),
      kind: 'operation',
      sourceKeys: operation.sourceKeys,
      operation,
    }
    operationsById.set(operation.id, node)
    nodes.push(node)
    return { node, created: true }
  }

  for (const item of items) {
    const targetIds = new Set<string>()
    let newNodeCount = 0
    let fallbackNodeCount = 0
    const addNode = (node: PresentationNode): void => {
      nodes.push(node)
      targetIds.add(node.id)
      newNodeCount += 1
      if (node.kind === 'fallback') fallbackNodeCount += 1
    }
    const noteOperation = (result: { node: OperationNode; created: boolean }): void => {
      targetIds.add(result.node.id)
      if (result.created) newNodeCount += 1
    }

    if (item.type === 'entry') {
      const entry = item.entry
      // Compact summaries and task-notification carrier entries have product
      // semantics above their raw conversation blocks.  Passing them through as
      // system nodes preserves those established rows without letting EntryRow
      // become a second operation dispatcher again.
      if (
        isCompactBoundaryEntry(entry) ||
        isCompactSummaryEntry(entry) ||
        taskNotificationFromEntry(entry) ||
        !isConversationEntry(entry)
      ) {
        addNode({
          ...baseForItem(item, `system:${item.key}`),
          kind: 'system',
          system: { type: 'entry', entry },
        })
      } else {
        const role = entry.message.role
        const content = entry.message.content
        if (typeof content === 'string') {
          if (content.length > 0) {
            addNode({
              ...baseForItem(item, `message:${item.key}:text`),
              kind: 'message',
              role,
              text: content,
              streaming: false,
              citations: [],
            })
          }
        } else if (Array.isArray(content)) {
          content.forEach((block, blockIndex) => {
            const sourceKey = `${item.key}:block:${blockIndex}`
            const idSuffix = `${item.key}:${blockIndex}`
            switch (blockType(block)) {
              case 'text': {
                const textValue = (block as { text?: unknown }).text
                const text = typeof textValue === 'string' ? textValue : ''
                const citationsValue = (block as { citations?: unknown }).citations
                const citations = Array.isArray(citationsValue) ? citationsValue : []
                if (!text && citations.length === 0) return
                addNode({
                  ...baseForItem(item, `message:${idSuffix}`),
                  sourceKeys: [item.key, sourceKey],
                  kind: 'message',
                  role,
                  text,
                  streaming: false,
                  citations,
                })
                return
              }
              case 'thinking':
              case 'redacted_thinking': {
                const redacted = blockType(block) === 'redacted_thinking'
                const thinkingValue = (block as { thinking?: unknown }).thinking
                const text = typeof thinkingValue === 'string' ? thinkingValue : ''
                // Empty persisted thinking is expected: providers commonly keep
                // only a signature after sealing.  It is intentionally accounted
                // for by the entry receipt but does not create a blank DOM row.
                if (!redacted && !text) return
                addNode({
                  ...baseForItem(item, `thinking:${idSuffix}`),
                  sourceKeys: [item.key, sourceKey],
                  kind: 'thinking',
                  text,
                  streaming: false,
                  redacted,
                })
                return
              }
              case 'image':
                addNode({
                  ...baseForItem(item, `image:${idSuffix}`),
                  sourceKeys: [item.key, sourceKey],
                  kind: 'image',
                  role,
                  block,
                })
                return
              case 'tool_use': {
                const toolUse = block as ToolUseBlock
                const indexedResult = toolResultIndex.get(toolUse.id) ?? null
                noteOperation(addOperation(
                  item,
                  operationFromCommitted({
                    provider,
                    toolUse,
                    result:
                      indexedResult && !visibleResultIds.has(toolUse.id)
                        ? indexedResult
                        : null,
                    sourceKey,
                  }),
                  sourceKey,
                ))
                return
              }
              case 'tool_result': {
                const result = block as ToolResultBlock
                const sourceTool = toolUseIndex.get(result.tool_use_id) ?? null
                const targetId = operationId(provider, result.tool_use_id || sourceKey)
                const existing = operationsById.get(targetId)
                if (existing) {
                  mergeOperation(
                    existing.operation,
                    operationFromStandaloneResult({
                      provider,
                      result,
                      sourceKey,
                      sourceTool,
                    }),
                  )
                  if (!existing.sourceKeys.includes(item.key)) {
                    existing.sourceKeys.push(item.key)
                  }
                  targetIds.add(existing.id)
                } else {
                  noteOperation(addOperation(
                    item,
                    operationFromStandaloneResult({
                      provider,
                      result,
                      sourceKey,
                      sourceTool,
                    }),
                    sourceKey,
                  ))
                }
                return
              }
              default:
                addNode({
                  ...baseForItem(item, `fallback:${idSuffix}`),
                  sourceKeys: [item.key, sourceKey],
                  kind: 'fallback',
                  label: blockType(block),
                  value: block,
                  role,
                })
            }
          })
        } else {
          addNode({
            ...baseForItem(item, `fallback:${item.key}:conversation-content`),
            kind: 'fallback',
            label: 'conversation content',
            value: content,
            role,
          })
        }
      }
    } else if (item.type === 'semantic-block') {
      const block = item.block
      if (isSemanticOperationBlock(block)) {
        noteOperation(addOperation(
          item,
          operationFromLive({
            provider,
            block,
            toolState: item.toolState,
            sourceKey: item.key,
          }),
          item.key,
        ))
      } else if (isSemanticOutputBlock(block)) {
        const correlationId = operationCorrelationIdForLive(block, item.key)
        const id = operationId(provider, correlationId)
        const existing = operationsById.get(id)
        const incoming = operationFromLive({
          provider,
          block,
          toolState: item.toolState,
          sourceKey: item.key,
        })
        const outputValue = semanticOutputValue(block)
        incoming.liveOutputs = [outputValue]
        incoming.liveOutput = outputValue
        if (existing) {
          mergeOperation(existing.operation, incoming)
          targetIds.add(existing.id)
        } else {
          noteOperation(addOperation(item, incoming, item.key))
        }
      } else if (block.kind === 'redacted_thinking') {
        addNode({
          ...baseForItem(item, `thinking:${item.key}`),
          kind: 'thinking',
          text: '',
          streaming: !block.finalized,
          redacted: true,
        })
      } else if (block.kind === 'thinking' || block.kind === 'reasoning') {
        const summary = block.reasoningSummary ?? ''
        const full = block.thinking || block.reasoningText || ''
        const text = summary && full && summary !== full
          ? `${summary}\n\n---\n\n${full}`
          : full || summary
        if (text) {
          addNode({
            ...baseForItem(item, `thinking:${item.key}`),
            kind: 'thinking',
            text,
            streaming: !block.finalized,
            redacted: false,
          })
        }
      } else if (SEMANTIC_TEXT_KINDS.has(block.kind)) {
        const citations = Array.isArray(block.citations) ? block.citations : []
        // Some provider items contain citations without prose. That is still
        // user-visible evidence (the previous row painted the sources/count),
        // so do not classify it as empty protocol noise merely because text is
        // an empty string.
        if (typeof block.text === 'string' && (block.text || citations.length > 0)) {
          addNode({
            ...baseForItem(item, `message:${item.key}`),
            kind: 'message',
            role: 'assistant',
            text: block.text,
            streaming: !block.finalized,
            citations,
          })
        }
      } else {
        // foldEvent initializes `text: ''` on every semantic block skeleton.
        // Checking only `typeof block.text` therefore made this fallback
        // unreachable for unknown future kinds and converted selected content
        // into a dishonest "known no-visible content" receipt. Kind, not the
        // presence of the shared accumulator field, decides text semantics.
        addNode({
          ...baseForItem(item, `fallback:${item.key}`),
          kind: 'fallback',
          label: block.kind || 'semantic block',
          value: block,
          role: 'assistant',
        })
      }
    } else if (item.type === 'semantic-collapsed-activity') {
      addNode({
        ...baseForItem(item, `activity:${item.key}`),
        kind: 'activity',
        unit: item.unit,
      })
    } else if (item.type === 'semantic-text') {
      addNode({
        ...baseForItem(item, `message:${item.key}`),
        kind: 'message',
        role: 'assistant',
        text: item.text,
        streaming: item.owner === 'semantic-current',
        citations: [],
      })
    } else if (item.type === 'work') {
      addNode({
        ...baseForItem(item, `system:${item.key}`),
        kind: 'system',
        system: {
          type: 'work',
          phase: item.phase,
          toolName: item.toolName,
          toolUseId: item.toolUseId,
        },
      })
    } else {
      addNode({
        ...baseForItem(item, `system:${item.key}`),
        kind: 'system',
        system: { type: 'empty', provider: item.provider },
      })
    }

    const targets = [...targetIds]
    const disposition: ProjectionReceipt['disposition'] =
      newNodeCount === 0
        ? 'absorbed'
        : fallbackNodeCount === newNodeCount
          ? 'fallback'
          : 'painted'
    receipts.push({
      sourceKey: item.key,
      disposition,
      targetIds: targets,
      reason:
        disposition === 'absorbed'
          ? targets.length > 0
            ? 'source evidence merged into an existing operation row'
            : 'known source item contains no user-visible content'
          : disposition === 'fallback'
            ? 'unknown source shape is represented by an explicit fallback'
            : targets.length > 1
              ? `source item projected to ${targets.length} presentation rows`
              : 'source item projected to a presentation row',
    })
  }

  const groupedNodes = groupAdjacentSpawnOperations(nodes, provider)
  const groupByMember = new Map<string, string>()
  for (const node of groupedNodes) {
    if (node.kind !== 'operation-group') continue
    for (const operationId of node.operationIds) groupByMember.set(operationId, node.id)
  }
  for (const receipt of receipts) {
    const groupIds = new Set(
      receipt.targetIds
        .map(targetId => groupByMember.get(targetId))
        .filter((groupId): groupId is string => Boolean(groupId)),
    )
    if (groupIds.size > 0) {
      receipt.targetIds.push(...groupIds)
      receipt.reason = 'source item projected to a collaboration group and operation row'
    }
  }

  return { nodes: groupedNodes, receipts }
}
