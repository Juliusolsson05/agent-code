import { useMemo, useRef } from 'react'

import type { AgentProviderKind } from '@shared/types/providerKind'
import type { FeedRenderItem } from '@renderer/features/feed/model/renderModel'
import type { RuntimeRenderInput } from '@renderer/session-runtime/state'
import {
  createLedgerInputAdapter,
  type RuntimeLedgerSlices,
} from '@renderer/rendering/adapter/collectLedgerInput'
import { createSessionLedger } from '@renderer/rendering/model/ledger'
import {
  ledgerFeedContextFromRuntime,
  ledgerToFeedItems,
} from '@renderer/features/feed/ledger/ledgerFeedItems'

// ---------------------------------------------------------------------------
// The producer hook: runtime → adapter → ledger → view bridge →
// FeedRenderItem[], which IS Feed's row list (passed via renderItemsOverride).
//
// Stage 3 cutover (2026-07): this hook is now UNCONDITIONAL — the ownership
// ledger is the sole decision core. It used to be gated behind an async
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
export function useLedgerFeedItems(
  runtime: RuntimeRenderInput,
  provider: AgentProviderKind,
  sessionId: string,
): FeedRenderItem[] {
  const adapterRef = useRef<ReturnType<typeof createLedgerInputAdapter> | null>(null)
  const ledgerRef = useRef<ReturnType<typeof createSessionLedger> | null>(null)

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
    const { items, dropped } = ledgerToFeedItems(
      ledger,
      ledgerFeedContextFromRuntime(runtime, provider),
    )
    if (dropped.length > 0) {
      // A dropped candidate is the "present but invisible" class (#239)
      // resurfacing through a lookup gap — always loud, never silent.
      // eslint-disable-next-line no-console
      console.warn('[render-pipeline] dropped candidates', { sessionId, dropped })
    }
    return items
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
  ])
}
