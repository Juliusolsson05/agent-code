import { fromCodexSemanticImageGeneration } from '@providers/codex/renderer/adapters/imageGeneration'
import { CodexImageGenerationRow } from '@providers/codex/renderer/components/image-generation'
import { renderCodexOperation } from '@providers/codex/renderer/rows/dispatch'
import { renderLiveProviderTool } from '@providers/shared/renderer/rows/LiveProviderToolRow'
import { boundedTextPage, TEXT_PAGE_MAX_CHARS } from '@renderer/lib/text/boundedText'
import { parseJsonRecord } from '@shared/lib/asRecord'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import type { SemanticLiveBlock } from '@renderer/session-runtime/state'
import type { ProviderSemanticDecision } from '@shared/types/providerConfig'
import { CompactionView } from '@providers/shared/renderer/protocols/compaction/CompactionView'

function semanticId(block: SemanticLiveBlock, prefix = 'live'): string {
  return block.callId ?? block.toolUseId ?? block.itemId ?? `${prefix}:${block.blockIndex}`
}

/** Normalize Codex Responses function/custom calls into the same provider
 * block consumed by durable rollout dispatch.
 *
 * WHY the raw fallback is page-bounded: parsedInput becomes authoritative as
 * soon as JSON closes. Until then this function runs for every delta; retaining
 * or reparsing the complete growing buffer would make a single large unified
 * exec script quadratic. The raw page is enough for prefix-tolerant command
 * and patch adapters, and the durable row retains the exact source. */
function codexSemanticTool(block: SemanticLiveBlock): ToolUseBlock | null {
  if (block.kind !== 'function_call' && block.kind !== 'custom_tool_call') return null
  const raw = block.argumentsJson ?? block.inputJson ?? ''
  const parsed = block.parsedInput ?? (
    raw && raw.length <= TEXT_PAGE_MAX_CHARS ? parseJsonRecord(raw) : null
  )
  const boundedRaw = boundedTextPage(raw).text
  return {
    type: 'tool_use',
    id: semanticId(block),
    name: block.toolName ?? block.kind,
    input: parsed ?? (boundedRaw ? { raw: boundedRaw, arguments: boundedRaw } : {}),
  }
}

function codexSemanticWebTool(block: SemanticLiveBlock): ToolUseBlock | null {
  if (block.kind !== 'web_search_call') return null
  const action = block.webSearchAction
  return {
    type: 'tool_use',
    id: semanticId(block, 'live-web'),
    name: 'web_search',
    input: {
      kind: action?.kind ?? 'search',
      query: action?.query ?? action?.queries?.slice(0, 6).join(', ') ?? null,
      url: action?.url ?? null,
      pattern: action?.pattern ?? null,
      status: block.status ?? null,
    },
  }
}

function codexSemanticShellTool(block: SemanticLiveBlock): ToolUseBlock | null {
  if (block.kind !== 'local_shell_call' || !block.localShellCall) return null
  const shell = block.localShellCall
  return {
    type: 'tool_use',
    id: semanticId(block, 'live-shell'),
    name: 'exec_command',
    input: {
      cmd: shell.command,
      workdir: shell.workingDirectory,
      yield_time_ms: shell.timeoutMs,
    },
  }
}

/** Provider-owned live semantic dispatch. The central feed deliberately knows
 * none of `function_call`, `web_search_call`, `local_shell_call`, or image
 * generation's typed payload; it only calls this capability and owns the
 * provider-neutral prose/reasoning fallback. */
export function renderCodexSemanticBlock(
  block: SemanticLiveBlock,
  context: {
    committedToolResults: ReadonlyMap<string, ToolResultBlock>
  },
): ProviderSemanticDecision | undefined {
  if (block.kind === 'compaction') {
    // Codex emits a structured semantic item for compaction; treating the
    // mostly-empty normalized object as a generic JSON marker was both noisy
    // and misleading. The item lifecycle itself is sufficient for the live
    // progress surface, while the later durable `compacted` rollout remains
    // the replay source of truth for boundary + summary.
    const done = block.finalized === true
    return {
      action: 'render',
      node: (
        <CompactionView model={{
          kind: 'progress',
          phase: done ? 'done' : 'running',
          label: done ? 'Conversation compacted' : 'Compacting conversation…',
        }} />
      ),
      receipt: { rendererId: 'shared.compaction', protocolId: 'compaction.live' },
    }
  }
  const imageGeneration = fromCodexSemanticImageGeneration(block)
  if (imageGeneration) {
    return {
      action: 'render',
      node: <CodexImageGenerationRow model={imageGeneration} />,
      receipt: { rendererId: 'codex.rows.dispatch' },
    }
  }

  const tool = codexSemanticTool(block)
    ?? codexSemanticWebTool(block)
    ?? codexSemanticShellTool(block)
  if (!tool) return undefined

  return renderLiveProviderTool({
    tool,
    finalized: block.finalized === true,
    resultPresent: block.resultAt != null || block.resultContent != null,
    resultContent: block.resultContent ?? '',
    resultIsError: block.resultIsError === true,
    committedResults: context.committedToolResults,
    renderOperation: renderCodexOperation,
  })
}
