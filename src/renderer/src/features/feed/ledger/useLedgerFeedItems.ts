import { useMemo, useRef } from 'react'

import type { AgentProviderKind } from '@shared/types/providerKind'
import type { FeedRenderItem } from '@renderer/features/feed/model/renderModel'
import type { RuntimeRenderInput } from '@renderer/session-runtime/state'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { createLedgerInputAdapter } from '@renderer/rendering/adapter/collectLedgerInput'
import type { RuntimeLedgerSlices } from '@renderer/rendering/adapter/collectLedgerInput'
import { createSessionLedger } from '@renderer/rendering/model/ledger'
import {
  ledgerToFeedItems,
} from '@renderer/features/feed/ledger/ledgerFeedItems'
import {
  createCommittedOperationDecisionResolver,
  type CommittedOperationDecisionResolver,
} from '@renderer/features/feed/context'
import { buildToolResultIndex, buildToolUseIndex } from '@renderer/features/feed/lib/helpers'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { providerLedgerFeedContextFromRuntime } from '@renderer/features/feed/ledger/providerLedgerFeedContext'

// ---------------------------------------------------------------------------
// The producer hook: runtime → adapter → ledger → view bridge → a feed plan.
// The plan carries both Feed's row list and the exact operation resolver whose
// decisions produced it; sharing that resolver prevents the mounted tail from
// repeating provider admission work already performed by the bridge.
//
// Stage 3 cutover (2026-07): this hook is now UNCONDITIONAL — the ownership
// ledger remains the sole ownership/order core. The view bridge additionally
// proves whether a committed row has any paint after provider correlation,
// because that question cannot be answered from ownership data alone. It used
// to be gated behind an async
// probe of AGENT_CODE_RENDER_PIPELINE and return null (legacy fallback)
// until the probe resolved; that flag, the legacy `deriveFeedRenderModel`
// path it selected, and the shadow diff that proved the two agreed are all
// deleted. Shadow parity was green over the incident corpus + recorded
// sessions (see docs/rendering/legacy-deletion-manifest.md), which is the
// evidence that made this flip safe: identical item lists ⇒ identical paint
// through the unchanged row components.
//
// Adapter + ledger are per-mount refs so their last-call caches (D11) hold
// across renders; the memo keys on the exact runtime slice references the
// adapter caches compare, making "no real change ⇒ same items array ⇒ no
// Feed re-render" compose end to end.
// ---------------------------------------------------------------------------

// `runtime` is the DECLARED render-input contract, not the whole
// SessionRuntime — the decide layer's licensed surface is exactly those
// seven fields (#493 PR-2). Desktop passes the full runtime (structural
// subtype, same object, so the D11 identity chain is untouched); the
// remote client passes its minimal store object with no cast.
export type LedgerFeedPlan = {
  items: FeedRenderItem[]
  resolveOperation: CommittedOperationDecisionResolver
}

export function useLedgerFeedItems(
  runtime: RuntimeRenderInput,
  provider: AgentProviderKind,
  sessionId: string,
  operationIndices?: {
    toolUseIndex?: ReadonlyMap<string, ToolUseBlock>
    toolResultIndex?: ReadonlyMap<string, ToolResultBlock>
    version?: number
  },
): LedgerFeedPlan {
  const adapterRef = useRef<ReturnType<typeof createLedgerInputAdapter> | null>(null)
  const ledgerRef = useRef<ReturnType<typeof createSessionLedger> | null>(null)
  const resolveOperation = useMemo(
    () => createCommittedOperationDecisionResolver(
      getRendererProviderCapabilities(provider).renderOperation,
    ),
    [provider],
  )
  const fallbackToolUseIndex = useMemo(
    () => operationIndices?.toolUseIndex ? null : buildToolUseIndex(runtime.entries),
    [operationIndices?.toolUseIndex, runtime.entries],
  )
  const fallbackToolResultIndex = useMemo(
    () => operationIndices?.toolResultIndex ? null : buildToolResultIndex(runtime.entries),
    [operationIndices?.toolResultIndex, runtime.entries],
  )
  const toolUseIndex = useMemo(
    () => operationIndices?.toolUseIndex
      ? new Map(operationIndices.toolUseIndex)
      : fallbackToolUseIndex!,
    // WHY version is the invalidation signal for in-place runtime maps. The
    // resolver cache keys immutable block objects, so cloning the index does
    // not cause older operation models to be reparsed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [operationIndices?.toolUseIndex, operationIndices?.version, fallbackToolUseIndex],
  )
  const toolResultIndex = useMemo(
    () => operationIndices?.toolResultIndex
      ? new Map(operationIndices.toolResultIndex)
      : fallbackToolResultIndex!,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- same versioned map contract above.
    [operationIndices?.toolResultIndex, operationIndices?.version, fallbackToolResultIndex],
  )

  return useMemo(() => {
    adapterRef.current ??= createLedgerInputAdapter()
    ledgerRef.current ??= createSessionLedger()
    const slices: RuntimeLedgerSlices = {
      provider,
      sessionId,
      entries: runtime.entries,
      semanticCurrent: runtime.semantic.currentTurn,
      semanticHistory: runtime.semantic.history,
      ghosts: runtime.ghosts,
      streamPhase: runtime.streamPhase,
      lastJsonlEntryAtMs: runtime.lastJsonlEntryAt,
    }
    const ledger = ledgerRef.current(adapterRef.current(slices).input)
    const providerContext = providerLedgerFeedContextFromRuntime(runtime, provider, {
      toolUseIndex,
      toolResultIndex,
      resolveOperation,
    })
    const { items, dropped } = ledgerToFeedItems(ledger, providerContext.context)
    if (dropped.length > 0) {
      // A dropped candidate is the "present but invisible" class (#239)
      // resurfacing through a lookup gap — always loud, never silent.
      // eslint-disable-next-line no-console
      console.warn('[render-pipeline] dropped candidates', { sessionId, dropped })
    }
    return { items, resolveOperation }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the
    // exact runtime slice references the adapter's plane caches compare;
    // `runtime` itself would over-fire (it changes identity on unrelated
    // fields like scroll state), defeating the identity-stability chain.
  }, [
    provider,
    sessionId,
    runtime.entries,
    runtime.semantic.currentTurn,
    runtime.semantic.history,
    runtime.ghosts,
    runtime.streamPhase,
    runtime.streamPhasePendingToolName,
    runtime.streamPhasePendingToolUseId,
    runtime.lastJsonlEntryAt,
    toolUseIndex,
    toolResultIndex,
    resolveOperation,
  ])
}
