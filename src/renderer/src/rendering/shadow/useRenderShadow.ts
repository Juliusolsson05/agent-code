import { useEffect, useRef, useState } from 'react'

import type { AgentProviderKind } from '@shared/types/providerKind'
import { deriveFeedRenderModel } from '@renderer/features/feed/model/renderModel'
import { selectMergedEntries } from '@renderer/workspace/mergedEntries'
import type { SessionRuntime } from '@renderer/workspace/workspaceState'
import {
  createLedgerInputAdapter,
  type RuntimeLedgerSlices,
} from '@renderer/rendering/adapter/collectLedgerInput'
import { createSessionLedger } from '@renderer/rendering/model/ledger'
import {
  diffShadowUnits,
  ledgerUnits,
  legacyUnits,
  type LegacyItemLike,
  type ShadowDiffResult,
} from '@renderer/rendering/shadow/shadowDiff'

// ---------------------------------------------------------------------------
// Stage 2 shadow hook. Mounted in TileLeaf (the one component that holds the
// full SessionRuntime), OFF unless AGENT_CODE_RENDER_SHADOW=1 in the main
// process env — probed once per app lifetime through the existing dev-debug
// config channel, so the disabled path costs one resolved promise and a
// no-op effect per pane, ever.
//
// WHY the hook RECOMPUTES the legacy model instead of reading Feed's memo:
// Feed's renderModel lives at the bottom of a prop chain that intentionally
// re-derives committed projections and tool indexes; threading its output
// back up would add a prod-path coupling that exists only for diagnostics.
// The legacy functions are pure — calling them again on the same runtime
// tick yields the same items, and the double work only happens when the
// flag is on. The shadow (this file, shadowDiff, the flag plumbing) is
// DELETE-fated at Stage 3 cutover along with the legacy renderer itself.
//
// Divergence sinks, in order of usefulness:
//   1. module ring buffer on globalThis.__agentCodeRenderShadow — full
//      reports, newest last; the triage workflow is "reproduce, then copy
//      JSON from the console" and each report is a fixture seed.
//   2. console.warn once per (sessionId, divergence-signature) — the spam
//      guard matters because a stable divergence re-fires on every
//      runtime tick until fixed.
// ---------------------------------------------------------------------------

export type ShadowReport = {
  at: string
  sessionId: string
  provider: AgentProviderKind
  diff: ShadowDiffResult
}

const RING_MAX = 50
const ring: ShadowReport[] = []
const warned = new Set<string>()
;(globalThis as Record<string, unknown>).__agentCodeRenderShadow = ring

// One probe per app lifetime, shared by every pane. Falls back to disabled
// on any error (older preload, tests, storybook-like hosts).
let enabledProbe: Promise<boolean> | null = null
function probeEnabled(): Promise<boolean> {
  if (!enabledProbe) {
    enabledProbe = (async () => {
      try {
        const api = (window as unknown as {
          api?: { getDevDebugConfig?: () => Promise<{ renderShadowEnabled?: boolean }> }
        }).api
        const config = await api?.getDevDebugConfig?.()
        return config?.renderShadowEnabled === true
      } catch {
        return false
      }
    })()
  }
  return enabledProbe
}

function legacyItemsOf(runtime: SessionRuntime, provider: AgentProviderKind): LegacyItemLike[] {
  // Same inputs the real Feed path uses: ghost-folded entries + the
  // semantic planes + streamPhase. Tool indexes are omitted on purpose —
  // they only affect row INTERNALS (result pairing), never the visible
  // row list this diff compares.
  const merged = selectMergedEntries(runtime, runtime.semantic.currentTurn?.turnId ?? null)
  const model = deriveFeedRenderModel({
    provider,
    entries: merged,
    semanticHistory: runtime.semantic.history,
    semanticTurn: runtime.semantic.currentTurn,
    streamPhase: runtime.streamPhase,
    streamPhasePendingToolName: runtime.streamPhasePendingToolName,
    streamPhasePendingToolUseId: runtime.streamPhasePendingToolUseId,
  })
  return model.items.map((item): LegacyItemLike => {
    switch (item.type) {
      case 'entry':
        return { type: 'entry', entryUuid: typeof item.entry.uuid === 'string' ? item.entry.uuid : null }
      case 'semantic-history':
      case 'semantic-current':
        return { type: item.type, turnId: item.turn.turnId }
      case 'work':
        return { type: 'work' }
      case 'empty':
        return { type: 'empty' }
    }
  })
}

export function useRenderShadow(
  runtime: SessionRuntime,
  provider: AgentProviderKind,
  sessionId: string,
): void {
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    let alive = true
    void probeEnabled().then(v => {
      if (alive && v) setEnabled(true)
    })
    return () => {
      alive = false
    }
  }, [])

  // Adapter + ledger are per-session factories (last-call caches keyed on
  // slice references) — refs so identity survives re-renders and the D11
  // contract actually gets exercised on real ticks, not defeated by
  // re-creation.
  const adapterRef = useRef<ReturnType<typeof createLedgerInputAdapter> | null>(null)
  const ledgerRef = useRef<ReturnType<typeof createSessionLedger> | null>(null)

  useEffect(() => {
    if (!enabled) return
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
    const diff = diffShadowUnits(legacyUnits(legacyItemsOf(runtime, provider)), ledgerUnits(ledger))
    if (diff.divergences.length === 0) return

    const report: ShadowReport = {
      at: new Date().toISOString(),
      sessionId,
      provider,
      diff,
    }
    ring.push(report)
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX)

    const signature = `${sessionId}|${diff.divergences
      .map(d => (d.class === 'order-mismatch' ? `${d.class}@${d.index}` : `${d.class}:${d.unit}`))
      .join(',')}`
    if (!warned.has(signature)) {
      warned.add(signature)
      // eslint-disable-next-line no-console -- the shadow's entire job is
      // to surface divergences to a human watching the console.
      console.warn('[render-shadow] divergence', report)
    }
  }, [
    enabled,
    provider,
    sessionId,
    // The exact slice references the adapter caches key on — the effect
    // must fire iff a plane could have changed.
    runtime.entries,
    runtime.semantic.currentTurn,
    runtime.semantic.history,
    runtime.ghosts,
    runtime.streamPhase,
    runtime.streamPhasePendingToolName,
    runtime.streamPhasePendingToolUseId,
    runtime.lastJsonlEntryAt,
    runtime,
  ])
}
