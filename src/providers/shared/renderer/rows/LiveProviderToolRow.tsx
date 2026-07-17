import type { ReactNode } from 'react'

import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { ToolResultIndexContext } from '@renderer/features/feed/context'

import { GenericLiveResult } from './GenericLiveResult'

type ToolUseRenderer = (
  block: ToolUseBlock,
  context?: { live?: boolean; streaming?: boolean; result?: ToolResultBlock | null },
) => ReactNode | undefined

type ToolResultRenderer = (
  block: ToolResultBlock,
  context: { sourceTool?: ToolUseBlock | null },
) => ReactNode | undefined

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
  renderToolUse,
  renderToolResult,
}: {
  tool: ToolUseBlock
  finalized: boolean
  resultPresent: boolean
  resultContent: string
  resultIsError: boolean
  committedResults: ReadonlyMap<string, ToolResultBlock>
  renderToolUse: ToolUseRenderer
  renderToolResult: ToolResultRenderer
}): ReactNode | undefined {
  const result: ToolResultBlock | null = resultPresent
    ? {
        type: 'tool_result',
        tool_use_id: tool.id,
        content: resultContent,
        ...(resultIsError ? { is_error: true } : {}),
      }
    : null
  const toolRow = renderToolUse(tool, {
    live: true,
    streaming: result === null && !finalized,
    result,
  })
  if (toolRow === undefined) return undefined
  if (!result) return toolRow

  const renderedResult = renderToolResult(result, { sourceTool: tool })
  const resultRow = renderedResult === undefined ? (
    <GenericLiveResult
      source={resultContent || '(empty result)'}
      isError={resultIsError}
      allowDirectMcpArray={tool.name.startsWith('mcp__')}
    />
  ) : renderedResult

  // Owned cards such as tasks/workspaces read their paired result from feed
  // context and may deliberately absorb the separate result row. Clone the
  // map so React observes a new identity and the live card sees this result
  // before durable transcript catch-up.
  const liveResults = new Map(committedResults)
  liveResults.set(tool.id, result)
  return (
    <ToolResultIndexContext.Provider value={liveResults}>
      <div className="flex flex-col gap-2">
        {toolRow}
        {resultRow}
      </div>
    </ToolResultIndexContext.Provider>
  )
}
