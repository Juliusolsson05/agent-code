import type { ReactNode } from 'react'

import { EditRow } from '@providers/claude/renderer/components/edit'
import { ClaudeLiveBashRow } from '@providers/claude/renderer/components/bash'
import { renderClaudeOperation } from '@providers/claude/renderer/rows/dispatch'
import { renderLiveProviderTool } from '@providers/shared/renderer/rows/LiveProviderToolRow'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { StreamingCodeText } from '@renderer/lib/code/StreamingCodeText'
import { normalizeCodeLanguage } from '@shared/code/language'
import { fromClaudePartialEditJson } from '@providers/claude/renderer/adapters/codeEdit'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import type { SemanticLiveBlock } from '@renderer/session-runtime/state'
import type { ProviderSemanticDecision } from '@shared/types/providerConfig'

function semanticId(block: SemanticLiveBlock): string {
  return block.toolUseId ?? block.callId ?? block.itemId ?? `live:${block.blockIndex}`
}

function renderClaudeStreamingWrite(block: SemanticLiveBlock): ReactNode | undefined {
  // WHY admission delegates to the same prefix adapter tested below: keeping
  // a second path scanner here let tests prove behavior production never used.
  // StreamingCodeText remains the painter because it caches sealed lines; the
  // adapter supplies only the honest “closed non-blank path” threshold.
  const model = fromClaudePartialEditJson('Write', block.inputJson ?? '')
  if (!model) return undefined
  const write = model.files[0]
  // The adapter has already bounded both decoded characters and line count.
  // Reconstituting its addition-only preview keeps StreamingCodeText's sealed
  // line cache while ensuring production never decodes the raw input twice.
  const preview = write.lines.map(line => line.text).join('\n')
  return (
    <MarkerRow marker="⏺">
      <div className="mt-1 flex flex-col gap-1">
        <MarkerRow marker="⎿" tone="muted">
          <span className="font-code text-[12px] leading-[1.55] text-ink-dim break-all">
            {write.path}
          </span>
        </MarkerRow>
        {/* WHY partial Write does not use the committed highlighter: the
            buffer changes on every delta. StreamingCodeText caches sealed
            lines, preserving color without re-tokenizing all prior bytes. */}
        <StreamingCodeText
          code={preview}
          language={normalizeCodeLanguage(undefined, write.path)}
          tone="added"
        />
        {write.previewTruncated ? (
          <div className="text-[11px] text-muted">
            … streaming preview capped · +≥{write.additions} lines received
          </div>
        ) : null}
      </div>
    </MarkerRow>
  )
}

/** Claude semantic tool rendering belongs here, including the incomplete JSON
 * exceptions. The central feed now sees only a provider capability result and
 * never imports Claude components or decodes Claude tool input itself. */
export function renderClaudeSemanticBlock(
  block: SemanticLiveBlock,
  context: {
    committedToolResults: ReadonlyMap<string, ToolResultBlock>
  },
): ProviderSemanticDecision | undefined {
  if (
    block.kind !== 'tool_use' &&
    block.kind !== 'server_tool_use' &&
    block.kind !== 'mcp_tool_use'
  ) return undefined

  if (block.toolName && block.parsedInput && block.inputJsonValid !== false) {
    const tool: ToolUseBlock = {
      type: 'tool_use',
      id: semanticId(block),
      name: block.toolName,
      input: block.parsedInput,
    }
    const decision = renderLiveProviderTool({
      tool,
      finalized: block.finalized === true,
      resultPresent: block.resultAt != null || block.resultContent != null,
      resultContent: block.resultContent ?? '',
      resultIsError: block.resultIsError === true,
      committedResults: context.committedToolResults,
      renderOperation: renderClaudeOperation,
    })
    if (decision.action !== 'fallback') return decision
  }

  if (block.toolName === 'Bash') {
    return {
      action: 'render',
      receipt: { rendererId: 'claude.rows.dispatch' },
      node: (
        <ClaudeLiveBashRow
          parsedInput={block.parsedInput ?? null}
          inputJson={block.inputJson ?? ''}
          finalized={block.finalized === true}
          blockIndex={block.blockIndex}
        />
      ),
    }
  }
  if (block.toolName === 'Edit' && !block.parsedInput) {
    const model = fromClaudePartialEditJson('Edit', block.inputJson ?? '')
    return model
      ? {
          action: 'render',
          node: <EditRow model={model} />,
          receipt: { rendererId: 'claude.rows.dispatch' },
        }
      : undefined
  }
  if (block.toolName === 'Write') {
    const node = renderClaudeStreamingWrite(block)
    return node === undefined
      ? undefined
      : {
          action: 'render',
          node,
          receipt: { rendererId: 'claude.rows.dispatch' },
        }
  }

  return undefined
}
