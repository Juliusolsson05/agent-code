import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import {
  createCommittedOperationDecisionResolver,
  type CommittedOperationDecisionResolver,
} from '@renderer/features/feed/context'
import { buildToolResultIndex, buildToolUseIndex } from '@renderer/features/feed/lib/helpers'
import {
  ledgerFeedContextFromRuntime,
  type LedgerFeedContext,
} from '@renderer/features/feed/ledger/ledgerFeedItems'
import { committedEntryPaints } from '@renderer/features/feed/model/entryVisibility'
import type { RuntimeRenderInput } from '@renderer/session-runtime/state'
import type { AgentProviderKind } from '@shared/types/providerKind'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

export type ProviderLedgerFeedContext = {
  context: LedgerFeedContext
  resolveOperation: CommittedOperationDecisionResolver
}

/**
 * Add provider correlation to the otherwise provider-agnostic ledger bridge.
 *
 * WHY this factory is shared by live rendering and replay: a transcript made
 * entirely from provider-absorbed result carriers is the dangerous boundary.
 * The entry-grain ledger still selects those carriers, but the provider pair
 * decision proves that none paint. If replay projects only the pre-correlation
 * ledger it cannot detect the blank-feed regression production users see.
 * Keeping the join here makes production, recording replay, and invariant
 * replay ask the same question with the same provider adapter.
 *
 * Live callers supply their versioned incremental indices and persistent
 * WeakMap resolver. Replay intentionally omits them and pays the bounded
 * per-tick rebuild so its result does not depend on renderer component state.
 */
export function providerLedgerFeedContextFromRuntime(
  runtime: RuntimeRenderInput,
  provider: AgentProviderKind,
  options: {
    toolUseIndex?: Map<string, ToolUseBlock>
    toolResultIndex?: Map<string, ToolResultBlock>
    resolveOperation?: CommittedOperationDecisionResolver
  } = {},
): ProviderLedgerFeedContext {
  const toolUseIndex = options.toolUseIndex ?? buildToolUseIndex(runtime.entries)
  const toolResultIndex = options.toolResultIndex ?? buildToolResultIndex(runtime.entries)
  const resolveOperation = options.resolveOperation ?? createCommittedOperationDecisionResolver(
    getRendererProviderCapabilities(provider).renderOperation,
  )
  const context = ledgerFeedContextFromRuntime(runtime, provider)
  context.committedEntryPaints = entry => committedEntryPaints({
    entry,
    toolUseIndex,
    toolResultIndex,
    resolveOperation,
  })
  return { context, resolveOperation }
}
