import { useEffect, useMemo, useRef, useState } from 'react'

import type { AgentProviderKind } from '@shared/types/providerKind'
import type { FeedRenderItem } from '@renderer/features/feed/model/renderModel'
import type { SessionRuntime } from '@renderer/workspace/workspaceState'
import {
  createLedgerInputAdapter,
  type RuntimeLedgerSlices,
} from '@renderer/rendering/adapter/collectLedgerInput'
import { createSessionLedger } from '@renderer/rendering/model/ledger'
import {
  ledgerFeedContextFromRuntime,
  ledgerToFeedItems,
} from '@renderer/rendering/view/ledgerFeedItems'

// ---------------------------------------------------------------------------
// Stage 3 producer hook: runtime → adapter → ledger → view bridge →
// FeedRenderItem[] for Feed's `renderItemsOverride` prop.
//
// Returns null when AGENT_CODE_RENDER_PIPELINE is off — TileLeaf passes
// null through and Feed runs its legacy derivation, byte-identical
// behavior. The flag is probed ONCE per app lifetime (same channel as the
// shadow/dev-debug flags); until the probe resolves the hook returns null,
// so a session's first paint may be legacy even with the flag on — one
// tick of legacy paint beats blocking first paint on IPC.
//
// Adapter + ledger are per-mount refs so their last-call caches (D11) hold
// across renders; the memo keys on the exact runtime slice references the
// adapter caches compare, making "no real change ⇒ same items array ⇒ no
// Feed re-render" compose end to end.
// ---------------------------------------------------------------------------

let pipelineProbe: Promise<boolean> | null = null
function probePipelineEnabled(): Promise<boolean> {
  if (!pipelineProbe) {
    pipelineProbe = (async () => {
      try {
        const api = (window as unknown as {
          api?: { getDevDebugConfig?: () => Promise<{ renderPipelineEnabled?: boolean }> }
        }).api
        const config = await api?.getDevDebugConfig?.()
        return config?.renderPipelineEnabled === true
      } catch {
        return false
      }
    })()
  }
  return pipelineProbe
}

export function useLedgerFeedItems(
  runtime: SessionRuntime,
  provider: AgentProviderKind,
  sessionId: string,
): FeedRenderItem[] | null {
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    let alive = true
    void probePipelineEnabled().then(v => {
      if (alive && v) setEnabled(true)
    })
    return () => {
      alive = false
    }
  }, [])

  const adapterRef = useRef<ReturnType<typeof createLedgerInputAdapter> | null>(null)
  const ledgerRef = useRef<ReturnType<typeof createSessionLedger> | null>(null)

  return useMemo(() => {
    if (!enabled) return null
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
    enabled,
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
