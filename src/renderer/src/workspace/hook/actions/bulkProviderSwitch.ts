import { useCallback } from 'react'

import type { ProviderSwitchBatchAgent, SessionId } from '@renderer/workspace/types'
import type { AgentProviderKind } from '@shared/types/providerKind'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { WorkspaceSetRuntimes, WorkspaceSetState } from '@renderer/workspace/hook/context'
import type { SessionActions } from '@renderer/workspace/hook/actions/session'
import { switchAgentProvider } from '@renderer/workspace/hook/actions/providerSwitchCore'

// Bulk provider switch + remembered-batch return.
//
// This is the "I hit a usage limit" escape hatch: move a whole batch of agents
// from one provider to the other in one action, and remember that exact batch
// so it can be sent back later (limit reset) without re-selecting everything.
//
// Both directions go through the SAME single-agent core (switchAgentProvider),
// so "return" is literally the forward switch pointed the other way on a
// remembered set. We deliberately re-translate on return rather than
// snapshot-restoring the pre-switch transcript: the whole point of parking
// agents on the other provider is to KEEP WORKING there, and a snapshot restore
// would silently drop every turn done after the switch.

function providerLabel(kind: AgentProviderKind): string {
  return kind === 'codex' ? 'Codex' : 'Claude'
}

function pluralAgents(n: number): string {
  return `${n} agent${n === 1 ? '' : 's'}`
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
  ) => Promise<void>
  returnLastProviderSwitchBatch: () => Promise<void>
} {
  const switchAgentsToProvider = useCallback(
    async (sessionIds: SessionId[], targetKind: AgentProviderKind) => {
      if (sessionIds.length === 0) return

      // Sequential, not concurrent. switchAgentProvider → replaceSession mutates
      // load-bearing shared state (tile tree, detached map, runtime maps) per
      // agent. Firing N switches at once would make each read a stale snapshot
      // and could drop layout bookkeeping. This mirrors Close Old Agents'
      // sequential close loop and its rationale; a usage-limit escape is rare
      // enough that predictable mutation beats raw speed.
      const switched: ProviderSwitchBatchAgent[] = []
      let failed = 0

      for (const sessionId of sessionIds) {
        // Read meta fresh each iteration — earlier switches have already mutated
        // the session map. We capture originalKind/cwd/title BEFORE the switch
        // because afterward this id is dead (replaceSession mints a new one).
        const meta = refs.stateRef.current.sessions[sessionId]
        const originalKind =
          meta?.kind === 'codex' || meta?.kind === 'claude' ? meta.kind : null

        const result = await switchAgentProvider({
          sessionId,
          targetKind,
          refs,
          setRuntimes,
          sessionActions,
        })

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

      const base = `Switched ${pluralAgents(switched.length)} to ${providerLabel(targetKind)}`
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
      const currentKind = meta.kind ?? 'claude'
      if (currentKind !== agent.switchedToKind) {
        skipped += 1
        continue
      }

      const result = await switchAgentProvider({
        sessionId: agent.sessionId,
        targetKind: agent.originalKind,
        refs,
        setRuntimes,
        sessionActions,
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
