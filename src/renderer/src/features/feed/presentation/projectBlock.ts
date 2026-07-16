import type { AgentProviderKind } from '@shared/types/providerKind'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { asRecord } from '@shared/lib/asRecord'

import type {
  SemanticLiveBlock,
  SemanticToolCallSnapshot,
} from '@renderer/session-runtime/state'
import {
  patchResultMeta,
  unifiedExecScript,
} from '@providers/codex/renderer/extractors'
import type {
  OperationLifecycle,
  OperationVM,
} from '@renderer/features/feed/presentation/types'
import { classifyOperation } from '@renderer/features/feed/presentation/classifyOperation'

export function semanticOperationToolName(block: SemanticLiveBlock): string {
  if (block.toolName) return block.toolName
  switch (block.kind) {
    case 'web_search_call':
      return 'web_search_call'
    case 'image_generation_call':
      return 'image_generation_call'
    case 'local_shell_call':
      return 'local_shell_call'
    case 'tool_search_call':
      return 'tool_search_call'
    default:
      return block.kind
  }
}

export function isSemanticOperationBlock(block: SemanticLiveBlock): boolean {
  return (
    block.kind === 'function_call' ||
    block.kind === 'custom_tool_call' ||
    block.kind === 'tool_use' ||
    block.kind === 'server_tool_use' ||
    block.kind === 'mcp_tool_use' ||
    block.kind === 'web_search_call' ||
    block.kind === 'image_generation_call' ||
    block.kind === 'local_shell_call' ||
    block.kind === 'tool_search_call'
  )
}

export function isSemanticOutputBlock(block: SemanticLiveBlock): boolean {
  return (
    block.kind === 'function_call_output' ||
    block.kind === 'custom_tool_call_output' ||
    block.kind === 'tool_search_output'
  )
}

export function operationCorrelationIdForLive(
  block: SemanticLiveBlock,
  fallback: string,
): string {
  return block.toolUseId ?? block.callId ?? block.itemId ?? fallback
}

export function operationId(
  provider: AgentProviderKind,
  correlationId: string,
): string {
  return `operation:${provider}:${correlationId}`
}

export function lifecycleFromCommitted(
  provider: AgentProviderKind,
  toolUse: ToolUseBlock,
  result: ToolResultBlock | null,
): OperationLifecycle {
  if (result) return result.is_error === true ? 'error' : 'complete'

  const status = String(asRecord(toolUse.input)?.status ?? '').toLowerCase()
  if (status === 'error' || status === 'failed' || status === 'failure') return 'error'
  if (status === 'cancelled' || status === 'canceled') return 'cancelled'
  if (status === 'denied' || status === 'rejected') return 'denied'
  if (status === 'completed' || status === 'complete' || status === 'success') {
    return 'complete'
  }

  // OpenCode's durable mapper withholds the assistant entry until the source
  // message has `time.completed`. A successful no-output tool therefore has no
  // synthetic tool_result by design; treating absence as "still running"
  // leaves restored cards spinning forever even though the provider turn is
  // sealed. Claude/Codex may commit calls before their results and stay running.
  if (provider === 'opencode') return 'complete'
  return 'running'
}

export function lifecycleFromLive(
  block: SemanticLiveBlock,
  toolState: SemanticToolCallSnapshot | null,
): OperationLifecycle {
  // Responses adapters do not always mirror a typed item's nested status onto
  // the shared block.status field. Image generation and local shell snapshots
  // can therefore be self-contained terminal items. Collect every status that
  // exists in today's SemanticLiveBlock contract and resolve them by severity;
  // choosing only the first would let a stale outer `in_progress` hide a nested
  // failure/completion (or vice versa).
  const statuses = [
    block.status,
    block.imageGeneration?.status,
    block.localShellCall?.status,
  ]
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.toLowerCase())
  const hasStatus = (...values: string[]) =>
    statuses.some(status => values.includes(status))
  if (
    toolState?.status === 'error' ||
    block.resultIsError === true ||
    hasStatus('error', 'failed', 'failure')
  ) return 'error'
  if (hasStatus('denied', 'rejected')) return 'denied'
  if (hasStatus('cancelled', 'canceled')) return 'cancelled'

  // `resultContent` is an APPEND-ONLY stdout accumulator. Its first byte proves
  // the operation is running, not that it is finished: Codex's tool_output_delta
  // branch updates this field on every chunk and stamps `resultAt` only when the
  // explicit tool_completed event arrives. Treating mere content as completion
  // made the badge flip to ✓ while output was still visibly streaming. In
  // contrast, a normalized terminal item status is the only completion signal
  // available for server-executed response items such as web/image/tool search,
  // so it must be honored even when they do not emit a separate result block.
  if (hasStatus('completed', 'complete', 'success', 'succeeded')) return 'complete'
  if (
    block.resultAt != null ||
    block.output !== undefined ||
    toolState?.status === 'completed'
  ) {
    return 'complete'
  }
  if (
    block.resultContent != null ||
    block.finalized === true ||
    toolState?.status === 'in_progress'
  ) return 'running'
  return 'streaming'
}

export function operationFromCommitted({
  provider,
  toolUse,
  result,
  sourceKey,
}: {
  provider: AgentProviderKind
  toolUse: ToolUseBlock
  result: ToolResultBlock | null
  sourceKey: string
}): OperationVM {
  const rawInput =
    toolUse.name === 'exec'
      ? unifiedExecScript(toolUse.input)
      : null
  const classification = classifyOperation({
    provider,
    toolName: toolUse.name,
    rawInput,
    finalized: true,
  })
  return {
    id: operationId(provider, toolUse.id),
    provider,
    family: classification.family,
    classification,
    lifecycle: lifecycleFromCommitted(provider, toolUse, result),
    toolName: classification.displayToolName ?? toolUse.name,
    correlationId: toolUse.id,
    sourceKeys: [sourceKey],
    committedToolUse: toolUse,
    committedResults: result ? [result] : [],
    committedResult: result,
    liveBlock: null,
    liveToolState: null,
    liveOutputs: [],
    liveOutput: undefined,
    standaloneResults: [],
    standaloneResult: null,
  }
}

export function operationFromLive({
  provider,
  block,
  toolState,
  sourceKey,
}: {
  provider: AgentProviderKind
  block: SemanticLiveBlock
  toolState: SemanticToolCallSnapshot | null
  sourceKey: string
}): OperationVM {
  const correlationId = operationCorrelationIdForLive(block, sourceKey)
  const toolName = semanticOperationToolName(block)
  const classification = classifyOperation({
    provider,
    toolName,
    rawInput: block.argumentsJson ?? block.inputJson ?? null,
    finalized: block.finalized === true,
  })
  return {
    id: operationId(provider, correlationId),
    provider,
    family: classification.family,
    classification,
    lifecycle:
      classification.family === 'preparing'
        ? 'preparing'
        : lifecycleFromLive(block, toolState),
    toolName: classification.displayToolName ?? toolName,
    correlationId,
    sourceKeys: [sourceKey],
    committedToolUse: null,
    committedResults: [],
    committedResult: null,
    liveBlock: block,
    liveToolState: toolState,
    liveOutputs: [],
    liveOutput: undefined,
    standaloneResults: [],
    standaloneResult: null,
  }
}

export function operationFromStandaloneResult({
  provider,
  result,
  sourceKey,
  sourceTool,
}: {
  provider: AgentProviderKind
  result: ToolResultBlock
  sourceKey: string
  sourceTool: ToolUseBlock | null
}): OperationVM {
  if (sourceTool) {
    return operationFromCommitted({ provider, toolUse: sourceTool, result, sourceKey })
  }
  const correlationId = result.tool_use_id || sourceKey
  const patch = provider === 'codex' ? patchResultMeta(result) : null
  const classification = patch?.isPatchResult
    ? {
        family: 'file-change' as const,
        confidence: 'final' as const,
        evidence: 'Codex patch_apply_end result metadata',
      }
    : classifyOperation({
        provider,
        toolName: 'tool_result',
        finalized: true,
      })
  return {
    id: operationId(provider, correlationId),
    provider,
    family: classification.family,
    classification,
    lifecycle: result.is_error === true ? 'error' : 'complete',
    toolName: patch?.isPatchResult ? 'apply_patch' : 'tool_result',
    correlationId,
    sourceKeys: [sourceKey],
    committedToolUse: null,
    committedResults: [],
    committedResult: null,
    liveBlock: null,
    liveToolState: null,
    liveOutputs: [],
    liveOutput: undefined,
    standaloneResults: [result],
    standaloneResult: result,
  }
}

const LIFECYCLE_RANK: Record<OperationLifecycle, number> = {
  preparing: 0,
  streaming: 1,
  running: 2,
  complete: 3,
  denied: 3,
  cancelled: 3,
  error: 4,
}

/** Merge later evidence into the first anchored operation without changing id. */
export function mergeOperation(target: OperationVM, incoming: OperationVM): void {
  for (const sourceKey of incoming.sourceKeys) {
    if (!target.sourceKeys.includes(sourceKey)) target.sourceKeys.push(sourceKey)
  }
  if (incoming.committedToolUse) target.committedToolUse = incoming.committedToolUse
  for (const result of incoming.committedResults) {
    if (!target.committedResults.includes(result)) target.committedResults.push(result)
  }
  if (incoming.committedResult) {
    target.committedResult = preferredResult(target.committedResult, incoming.committedResult)
  }
  if (incoming.liveBlock) {
    const targetLength =
      (target.liveBlock?.argumentsJson ?? target.liveBlock?.inputJson ?? '').length
    const incomingLength =
      (incoming.liveBlock.argumentsJson ?? incoming.liveBlock.inputJson ?? '').length
    const targetIsOutput = target.liveBlock
      ? isSemanticOutputBlock(target.liveBlock)
      : false
    const incomingIsOutput = isSemanticOutputBlock(incoming.liveBlock)

    // A Responses output item shares the call id but not the call payload. It is
    // result EVIDENCE, never a richer version of the originating function_call.
    // `finalized` used to let that output skeleton replace the call, erasing the
    // command/params at the exact moment stdout arrived (`$ printf …` became
    // `$ …`). Keep output in the plural fields below. The one exception is an
    // orphan output already anchoring the operation: if its call arrives later,
    // the real call must replace that placeholder regardless of source order.
    const outputWouldEraseCall = incomingIsOutput && !targetIsOutput
    if (
      !outputWouldEraseCall &&
      (
        !target.liveBlock ||
        (targetIsOutput && !incomingIsOutput) ||
        incomingLength >= targetLength ||
        incoming.liveBlock.finalized
      )
    ) {
      target.liveBlock = incoming.liveBlock
      target.liveToolState = incoming.liveToolState
    }
  }
  // Output values may legitimately be byte-identical events. Do not dedupe by
  // value: sourceKeys account for event identity, while the ordered array keeps
  // the provider's complete output story. The singular view tracks the newest
  // output for old family adapters that have not yet accepted a list.
  for (const output of incoming.liveOutputs) target.liveOutputs.push(output)
  if (incoming.liveOutput !== undefined) target.liveOutput = incoming.liveOutput
  for (const result of incoming.standaloneResults) {
    if (!target.standaloneResults.includes(result)) target.standaloneResults.push(result)
  }
  if (incoming.standaloneResult) {
    target.standaloneResult = preferredResult(
      target.standaloneResult,
      incoming.standaloneResult,
    )
  }

  // Specific structural evidence is monotonic.  A later generic committed
  // wrapper must never turn an already-proven streaming patch back into a raw
  // tool row during the live→committed hand-off.
  if (target.family === 'preparing' || target.family === 'generic') {
    if (incoming.family !== 'preparing' || target.family === 'preparing') {
      target.family = incoming.family
      target.classification = incoming.classification
      target.toolName = incoming.toolName
    }
  }
  // A generated script can expose a command call before its later patch
  // declaration arrives. The patch literal is stronger user-intent evidence
  // and must win; otherwise the exact row that began correctly as "Running"
  // would keep showing wrapper command UI while source lines stream past it.
  if (
    incoming.family === 'file-change' &&
    target.family !== 'file-change' &&
    (target.committedToolUse?.name === 'exec' || target.liveBlock?.toolName === 'exec')
  ) {
    target.family = incoming.family
    target.classification = incoming.classification
    target.toolName = incoming.toolName
  }
  if (LIFECYCLE_RANK[incoming.lifecycle] >= LIFECYCLE_RANK[target.lifecycle]) {
    target.lifecycle = incoming.lifecycle
  }
}

/**
 * Pick the compatibility result without throwing away the ordered evidence.
 *
 * Errors and Codex patch metadata outrank a later generic wrapper. This is the
 * narrow rule required by observed duplicate-result transcripts: a successful
 * custom_tool_call_output must not overwrite an earlier failed patch_apply_end
 * and make the UI claim success. Rich renderers can still inspect the plural
 * arrays when they need every payload.
 */
function preferredResult(
  current: ToolResultBlock | null,
  incoming: ToolResultBlock,
): ToolResultBlock {
  if (!current) return incoming
  const rank = (result: ToolResultBlock): number =>
    (result.is_error === true ? 4 : 0) +
    // Preserve the patch event as the metadata carrier even when a later
    // generic wrapper fails. combinedToolResult makes `is_error` monotonic, so
    // keeping this base does not hide the later error; it keeps the file/diff
    // fields that the wrapper never had.
    (patchResultMeta(result).isPatchResult ? 8 : 0)
  return rank(incoming) > rank(current) ? incoming : current
}
