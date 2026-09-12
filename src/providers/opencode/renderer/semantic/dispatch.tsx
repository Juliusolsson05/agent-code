import { fromOpencodeApplyPatch, rawOpencodeApplyPatchText } from '@providers/opencode/renderer/adapters/codeEdit'
import { OpencodeApplyPatchRow } from '@providers/opencode/renderer/components/apply-patch'
import { renderOpencodeReadResult } from '@providers/opencode/renderer/components/read-result'
import { renderOpencodeOperation } from '@providers/opencode/renderer/rows/dispatch'
import { JsonToolRow } from '@providers/shared/renderer/rows/JsonToolRow'
import { renderLiveProviderTool } from '@providers/shared/renderer/rows/LiveProviderToolRow'
import type { SemanticLiveBlock } from '@renderer/session-runtime/state'
import type { ProviderSemanticDecision } from '@shared/types/providerConfig'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

function semanticId(block: SemanticLiveBlock): string {
  return block.toolUseId ?? block.callId ?? block.itemId ?? `live:${block.blockIndex}`
}

function opencodeSemanticTool(block: SemanticLiveBlock): ToolUseBlock | null {
  if (block.kind !== 'tool_use' || !block.toolName || !block.parsedInput) return null
  return {
    type: 'tool_use',
    id: semanticId(block),
    name: block.toolName,
    input: block.parsedInput,
  }
}

function semanticResult(block: SemanticLiveBlock, toolUseId: string): ToolResultBlock | null {
  if (block.resultAt == null && block.resultContent == null) return null
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: block.resultContent ?? '',
    ...(block.resultIsError === true ? { is_error: true } : {}),
  }
}

/** OpenCode live semantic dispatch.
 *
 * WHY this starts with finalized parsed inputs only: the retained OpenCode
 * evidence proves committed tool families first, while live SSE ownership is
 * only trustworthy once the reducer has the exact parsed input object that the
 * provider emitted. Claiming by tool name alone would repeat the PTY-era
 * mistake of letting transport vocabulary outrun reviewed structure. */
export function renderOpencodeSemanticBlock(
  block: SemanticLiveBlock,
  context: {
    committedToolResults: ReadonlyMap<string, ToolResultBlock>
  },
): ProviderSemanticDecision | undefined {
  const tool = opencodeSemanticTool(block)
  if (!tool) return undefined

  const result = semanticResult(block, tool.id)

  // WHY `read` needs a provider-owned live branch even though its invocation
  // remains generic: OpenCode's durable renderer specializes the RESULT body,
  // not the request row. `renderLiveProviderTool` intentionally refuses to own
  // a semantic block when the invocation route is fallback-only, because that is
  // the safe default for most providers. For OpenCode read we already have a
  // reviewed result parser (`<path>…<content>` tag soup → code slab), so the
  // honest live UX is "generic invocation + owned result" rather than dropping
  // the whole pair back to the shared semantic fallback.
  if (tool.name === 'read' && result) {
    const ownedResult = renderOpencodeReadResult(result)
    if (ownedResult) {
      return {
        action: 'render',
        receipt: { rendererId: 'opencode.rows.dispatch' },
        node: (
          <div className="flex flex-col gap-2">
            <JsonToolRow block={tool} live />
            {ownedResult}
          </div>
        ),
      }
    }
  }

  const applyPatch = fromOpencodeApplyPatch(tool, {
    streaming: block.finalized !== true,
    result,
  })
  if (applyPatch) {
    return {
      action: 'render',
      receipt: { rendererId: 'opencode.rows.dispatch' },
      node: <OpencodeApplyPatchRow model={applyPatch} rawPatch={rawOpencodeApplyPatchText(tool)} />,
    }
  }

  return renderLiveProviderTool({
    tool,
    finalized: block.finalized === true,
    resultPresent: result !== null,
    resultContent: block.resultContent ?? '',
    resultIsError: block.resultIsError === true,
    committedResults: context.committedToolResults,
    renderOperation: renderOpencodeOperation,
  })
}
