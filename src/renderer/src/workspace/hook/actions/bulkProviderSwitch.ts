import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { useCallback } from 'react'

import type { ProviderSwitchBatchAgent, SessionId } from '@renderer/workspace/types'
import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type { AgentProviderKind } from '@shared/types/providerKind'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { WorkspaceSetRuntimes, WorkspaceSetState } from '@renderer/workspace/hook/context'
import type { SessionActions } from '@renderer/workspace/hook/actions/session'
import { switchAgentProvider } from '@renderer/workspace/hook/actions/providerSwitchCore'
import type { SwitchStrategy } from '@renderer/workspace/hook/actions/providerSwitchCore'

// Bulk provider switch + remembered-batch return.
//
// This is the "I hit a usage limit" escape hatch: move a whole batch of agents
// from one provider to another in one action, and remember that exact batch
// so it can be sent back later (limit reset) without re-selecting everything.
//
// Both directions go through the SAME single-agent core (switchAgentProvider),
// so "return" is literally the forward switch pointed the other way on a
// remembered set. We deliberately re-translate on return rather than
// snapshot-restoring the pre-switch transcript: the whole point of parking
// agents on the target provider is to KEEP WORKING there, and a snapshot restore
// would silently drop every turn done after the switch.

function providerLabel(kind: AgentProviderKind): string {
  // Registry-derived (#394 phase 4).
  return getRendererProviderCapabilities(kind).shortLabel
}

function pluralAgents(n: number): string {
  return `${n} agent${n === 1 ? '' : 's'}`
}

/**
 * What a batch is allowed to spend, decided ONCE by the modal for the whole
 * batch.
 *
 * WHY the caller owns this instead of the action defaulting it: the two halves
 * cost the user completely different things. `allowSourceTurns` spends the
 * SOURCE provider's quota — the one that is usually exhausted, which is why the
 * transaction defaults it off — and `compactOnArrival` spends the TARGET's.
 * Only the surface that showed the exhaustion banner knows which of those the
 * user just agreed to, and per the spec it asks once for the batch rather than
 * once per agent.
 */
export type BulkSwitchPolicy = {
  allowSourceTurns: boolean
  compactOnArrival: boolean
  sourceCompactionConfirmed: boolean
}

/** The return path has no modal, so it hard-codes the safe policy.
 *
 *  `allowSourceTurns: false` because the source here is the provider the user
 *  parked on, and a return usually happens because the ORIGINAL provider's
 *  window reset — nothing licenses spending the parking provider's quota, and
 *  the whole feature exists to avoid needing to.
 *
 *  `compactOnArrival` only for a Claude destination: Claude is the one target
 *  with a compaction the renderer can drive (see compactAfterSwitch, which
 *  reports every other kind as a no-op), and a returning transcript has grown
 *  by everything the agent did while parked. */
function returnPolicy(targetKind: AgentProviderKind): BulkSwitchPolicy {
  return {
    allowSourceTurns: false,
    compactOnArrival: targetKind === 'claude',
    sourceCompactionConfirmed: false,
  }
}

export function useBulkProviderSwitchActions(
  refs: WorkspaceRefs,
  setState: WorkspaceSetState,
  setRuntimes: WorkspaceSetRuntimes,
  showToast: (message: string, durationMs?: number) => void,
  sessionActions: SessionActions,
): {
  switchAgentsToProvider: (
    sessionIds: SessionId[],
    targetKind: AgentProviderKind,
    policy: BulkSwitchPolicy,
  ) => Promise<void>
  returnLastProviderSwitchBatch: () => Promise<void>
} {
  const switchAgentsToProvider = useCallback(
    async (sessionIds: SessionId[], targetKind: AgentProviderKind, policy: BulkSwitchPolicy) => {
      if (sessionIds.length === 0) return

      // Sequential, not concurrent. switchAgentProvider → replaceSession mutates
      // load-bearing shared state (tile tree, detached map, runtime maps) per
      // agent. Firing N switches at once would make each read a stale snapshot
      // and could drop layout bookkeeping. This mirrors Close Old Agents'
      // sequential close loop and its rationale; a usage-limit escape is rare
      // enough that predictable mutation beats raw speed.
      const switched: ProviderSwitchBatchAgent[] = []
      let failed = 0
      // Per-strategy tally, not a single "compacted" flag: a batch where nine
      // agents crossed losslessly and two had to be shrunk is a materially
      // different outcome from one where all eleven were shrunk, and the user
      // is the only one who can decide whether the loss mattered.
      const counts: Record<SwitchStrategy, number> = { native: 0, raw: 0, shrunk: 0 }

      for (const sessionId of sessionIds) {
        // Read meta fresh each iteration — earlier switches have already mutated
        // the session map. We capture originalKind/cwd/title BEFORE the switch
        // because afterward this id is dead (replaceSession mints a new one).
        const meta = refs.stateRef.current.sessions[sessionId]
        const originalKind =
          isAgentProviderKind(meta?.kind) ? meta.kind : null

        const result = await switchAgentProvider({
          sessionId,
          targetKind,
          refs,
          setRuntimes,
          sessionActions,
          contextPolicy: {
            allowSourceTurns: policy.allowSourceTurns,
            compactOnArrival: policy.compactOnArrival,
          },
          sourceCompactionConfirmed: policy.sourceCompactionConfirmed,
          onProgress: event => showToast(event.message, 305_000),
          // Arrival compaction fires long after this loop has moved on, so its
          // failure cannot join the batch summary. One toast per failing agent
          // is the honest report: the switch itself succeeded and the pane is
          // live with its full history.
          onArrivalFailure: message => showToast(message),
        })

        if (result.status === 'switched') counts[result.strategy] += 1
        if (result.status === 'switched' && meta && originalKind) {
          switched.push({
            sessionId: result.newSessionId,
            cwd: meta.cwd,
            originalKind,
            switchedToKind: targetKind,
            title: meta.title,
          })
        } else if (result.status === 'failed') {
          failed += 1
        }
        // 'skipped' (e.g. already on target) is silently not part of the batch.
      }

      // Replace the remembered batch outright — one level of memory only. If
      // nothing actually switched (all failed/skipped) we leave any prior batch
      // untouched: clobbering it with an empty record would needlessly forget a
      // batch the user might still want to return.
      if (switched.length > 0) {
        setState(prev => ({
          ...prev,
          lastProviderSwitchBatch: {
            id: `provider-switch-${Date.now()}`,
            switchedAt: Date.now(),
            sourceKind: switched[0].originalKind,
            targetKind,
            agents: switched,
          },
        }))
      }

      const tally = [
        counts.native > 0 ? `${counts.native} native` : null,
        counts.raw > 0 ? `${counts.raw} raw` : null,
        counts.shrunk > 0 ? `${counts.shrunk} shrunk` : null,
      ].filter(Boolean).join(', ')
      const base = `Switched ${pluralAgents(switched.length)} to ${providerLabel(targetKind)}${tally ? `: ${tally}` : ''}`
      showToast(failed > 0 ? `${base} (${failed} failed)` : base)
    },
    [refs, sessionActions, setRuntimes, setState, showToast],
  )

  const returnLastProviderSwitchBatch = useCallback(async () => {
    const batch = refs.stateRef.current.lastProviderSwitchBatch
    if (!batch) {
      showToast('No switched batch to return')
      return
    }

    let returned = 0
    let skipped = 0
    let failed = 0

    for (const agent of batch.agents) {
      const meta = refs.stateRef.current.sessions[agent.sessionId]
      // Only return agents still sitting where the forward switch left them.
      // Closed (no meta) or manually-moved (kind changed) agents are skipped so
      // we never yank an agent off a provider the user intentionally chose.
      if (!meta) {
        skipped += 1
        continue
      }
      const currentKind = meta.kind ?? DEFAULT_PROVIDER
      if (currentKind !== agent.switchedToKind) {
        skipped += 1
        continue
      }

      const policy = returnPolicy(agent.originalKind)
      const result = await switchAgentProvider({
        sessionId: agent.sessionId,
        targetKind: agent.originalKind,
        refs,
        setRuntimes,
        sessionActions,
        contextPolicy: {
          allowSourceTurns: policy.allowSourceTurns,
          compactOnArrival: policy.compactOnArrival,
        },
        sourceCompactionConfirmed: policy.sourceCompactionConfirmed,
        onProgress: event => showToast(event.message, 305_000),
        onArrivalFailure: message => showToast(message),
      })
      if (result.status === 'switched') returned += 1
      else if (result.status === 'failed') failed += 1
      else skipped += 1
    }

    // Returning consumes the batch — there is no "return again". A future
    // forward switch will record a fresh one.
    setState(prev => ({ ...prev, lastProviderSwitchBatch: null }))

    let message = `Returned ${pluralAgents(returned)} to ${providerLabel(batch.sourceKind)}`
    const notes: string[] = []
    if (skipped > 0) notes.push(`${skipped} skipped`)
    if (failed > 0) notes.push(`${failed} failed`)
    if (notes.length > 0) message += ` (${notes.join(', ')})`
    showToast(message)
  }, [refs, sessionActions, setRuntimes, setState, showToast])

  return { switchAgentsToProvider, returnLastProviderSwitchBatch }
}
