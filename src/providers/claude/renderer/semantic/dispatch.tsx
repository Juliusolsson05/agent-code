import type { ReactNode } from 'react'

import { EditRow } from '@providers/claude/renderer/components/edit'
import { MultiEditRow } from '@providers/claude/renderer/components/multi-edit'
import { ClaudeLiveBashRow } from '@providers/claude/renderer/components/bash'
import { renderClaudeOperation } from '@providers/claude/renderer/rows/dispatch'
import { renderLiveProviderTool } from '@providers/shared/renderer/rows/LiveProviderToolRow'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { extractStreamingWriteInput } from '@renderer/features/feed/lib/streamingWriteInput'
import { StreamingCodeText } from '@renderer/lib/code/StreamingCodeText'
import { normalizeCodeLanguage } from '@shared/code/language'
import { parseJsonRecord } from '@shared/lib/asRecord'
import {
  extractJsonStringField,
  fromClaudeEditBlock,
} from '@providers/claude/renderer/adapters/codeEdit'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { TEXT_PAGE_MAX_CHARS } from '@renderer/lib/text/boundedText'
import type { SemanticLiveBlock } from '@renderer/session-runtime/state'
import type { ProviderSemanticDecision } from '@shared/types/providerConfig'

function semanticId(block: SemanticLiveBlock): string {
  return block.toolUseId ?? block.callId ?? block.itemId ?? `live:${block.blockIndex}`
}

/** Extract a closed string member only during Claude's incomplete JSON
 * window. The reducer's parsedInput is authoritative once the object closes;
 * this bounded prefix parser exists solely so file-edit cards can appear while
 * old/new text is still streaming. */
function closedString(raw: string, key: string): string | null {
  const field = extractJsonStringField(raw, key)
  return field?.closed ? field.value : null
}

function claudePartialEditInput(block: SemanticLiveBlock): Record<string, unknown> | null {
  if (block.parsedInput) return block.parsedInput
  const raw = block.inputJson ?? ''
  const parsed = raw && raw.length <= TEXT_PAGE_MAX_CHARS ? parseJsonRecord(raw) : null
  if (parsed) return parsed
  if (!raw) return null
  const bounded = raw.slice(0, TEXT_PAGE_MAX_CHARS)
  const filePath = closedString(bounded, 'file_path')
  if (!filePath) return null
  if (block.toolName === 'MultiEdit') return { file_path: filePath, edits: [] }
  return {
    file_path: filePath,
    old_string: closedString(bounded, 'old_string') ?? '',
    new_string: closedString(bounded, 'new_string') ?? '',
  }
}

function renderClaudeStreamingWrite(block: SemanticLiveBlock): ReactNode | undefined {
  const write = extractStreamingWriteInput(block.inputJson ?? '')
  if (!write.filePath) return undefined
  return (
    <MarkerRow marker="⏺">
      <div className="mt-1 flex flex-col gap-1">
        <MarkerRow marker="⎿" tone="muted">
          <span className="font-code text-[12px] leading-[1.55] text-ink-dim break-all">
            {write.filePath}
          </span>
        </MarkerRow>
        {/* WHY partial Write does not use the committed highlighter: the
            buffer changes on every delta. StreamingCodeText caches sealed
            lines, preserving color without re-tokenizing all prior bytes. */}
        <StreamingCodeText
          code={write.partialContent ?? ''}
          language={normalizeCodeLanguage(undefined, write.filePath)}
          tone="added"
        />
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
  if (block.toolName === 'Edit' || block.toolName === 'MultiEdit') {
    const input = claudePartialEditInput(block)
    if (!input) return undefined
    const tool: ToolUseBlock = {
      type: 'tool_use',
      id: semanticId(block),
      name: block.toolName,
      input,
    }
    if (block.toolName === 'MultiEdit') {
      return {
        action: 'render',
        node: <MultiEditRow block={tool} />,
        receipt: { rendererId: 'claude.rows.dispatch' },
      }
    }
    const model = fromClaudeEditBlock(tool, { streaming: true })
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
