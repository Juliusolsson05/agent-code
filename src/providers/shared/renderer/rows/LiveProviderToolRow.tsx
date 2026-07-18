import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import type {
  ProviderOperationInput,
  ProviderSemanticDecision,
} from '@shared/types/providerConfig'
import { ToolResultIndexContext } from '@renderer/features/feed/context'

import { GenericLiveResult } from './GenericLiveResult'

type OperationRenderer = (
  input: ProviderOperationInput,
) => import('@shared/types/providerConfig').ProviderOperationDecision

/** Compose one provider-owned live invocation with its optional live result.
 *
 * WHY this is a provider-neutral helper instead of duplicated in Claude and
 * Codex: pairing a semantic result with its invocation is transcript topology,
 * not provider interpretation. The provider still decides whether it can
 * claim the invocation and whether a validated result is absorbed. Keeping
 * this glue shared makes live and committed dispatch use the same adapters
 * without teaching the central feed any provider tool names. */
export function renderLiveProviderTool({
  tool,
  finalized,
  resultPresent,
  resultContent,
  resultIsError,
  committedResults,
  renderOperation,
}: {
  tool: ToolUseBlock
  finalized: boolean
  resultPresent: boolean
  resultContent: string
  resultIsError: boolean
  committedResults: ReadonlyMap<string, ToolResultBlock>
  renderOperation: OperationRenderer
}): ProviderSemanticDecision {
  const result: ToolResultBlock | null = resultPresent
    ? {
        type: 'tool_result',
        tool_use_id: tool.id,
        content: resultContent,
        ...(resultIsError ? { is_error: true } : {}),
      }
    : null
  const decision = renderOperation({
    toolUse: tool,
    result,
    live: true,
    streaming: result === null && !finalized,
  })
  if (decision.toolUse.action === 'fallback') return { action: 'fallback' }
  if (decision.toolUse.action === 'absorb') return decision.toolUse
  const toolRow = decision.toolUse.node
  if (!result) return decision.toolUse

  const resultDecision = decision.toolResult
  const resultRow = resultDecision?.action === 'render'
    ? resultDecision.node
    : resultDecision?.action === 'absorb'
      ? null
      : (
          <GenericLiveResult
            source={resultContent || '(empty result)'}
            isError={resultIsError}
            allowDirectMcpArray={tool.name.startsWith('mcp__')}
          />
        )

  // Owned cards such as tasks/workspaces read their paired result from feed
  // context and may deliberately absorb the separate result row. Clone the
  // map so React observes a new identity and the live card sees this result
  // before durable transcript catch-up.
  const liveResults = new Map(committedResults)
  liveResults.set(tool.id, result)
  return {
    action: 'render',
    // The receipt remains the invocation renderer's receipt. The composed
    // node may append a generic result slab, but that does not transfer
    // ownership of the observed semantic invocation shape.
    receipt: decision.toolUse.receipt,
    node: (
      <ToolResultIndexContext.Provider value={liveResults}>
        <div className="flex flex-col gap-2">
          {toolRow}
          {resultRow}
        </div>
      </ToolResultIndexContext.Provider>
    ),
  }
}
