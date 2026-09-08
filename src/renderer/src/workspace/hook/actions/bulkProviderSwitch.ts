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
import { pluralAgents } from '@renderer/features/workspace/lib/sessionDisplay'

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

/** The return path has no modal, so it carries the batch's recorded consent.
 *
 *  `allowSourceTurns: false` because the source here is the provider the user
 *  parked on, and a return usually happens because the ORIGINAL provider's
 *  window reset — nothing licenses spending the parking provider's quota, and
 *  the whole feature exists to avoid needing to.
 *
 *  `compactOnArrival` was previously hard-coded to `targetKind === 'claude'`,
 *  which meant one Return click spent Claude quota once per agent and locked
 *  every one of those composers for the arrival wait plus the compaction wait
 *  — minutes each, no cancel — with no checkbox and none of the quota
 *  disclosure the forward modal shows. It now reuses the consent the user gave
 *  for this exact batch. `&& targetKind === 'claude'` still applies because
 *  Claude is the one destination with a compaction the renderer can drive
 *  (compactAfterSwitch reports every other kind as a no-op), so consenting to
 *  it on a Codex return would promise something that cannot happen. */
function returnPolicy(
  targetKind: AgentProviderKind,
  batchConsentedToArrivalCompaction: boolean,
): BulkSwitchPolicy {
  return {
    allowSourceTurns: false,
    compactOnArrival: batchConsentedToArrivalCompaction && targetKind === 'claude',
    sourceCompactionConfirmed: false,
  }
}

/**
 * Build the one toast a bulk operation gets.
 *
 * WHY the reasons ride along instead of only the counts: "Switched 0 agents to
 * Claude (12 failed)" tells the user nothing they can act on, and the core
 * deliberately produces strings that do — the poisoned-carrier abort names its
 * remedy, and the shrink ladder's summary exists so no lossy step is silent.
 * Deduped because a batch usually fails for one shared reason, and capped
 * because PaneToast clamps to three lines and an uncapped list would push the
 * counts out of view.
 */
const MAX_SUMMARY_NOTES = 2

function summarize(
  base: string,
  counts: { skipped: number; failed: number },
  notes: ReadonlySet<string>,
): string {
  const tally: string[] = []
  if (counts.skipped > 0) tally.push(`${counts.skipped} skipped`)
  if (counts.failed > 0) tally.push(`${counts.failed} failed`)
  let message = tally.length > 0 ? `${base} (${tally.join(', ')})` : base
  const shown = [...notes].slice(0, MAX_SUMMARY_NOTES)
  if (shown.length > 0) {
    const remaining = notes.size - shown.length
    message += ` · ${shown.join(' · ')}${remaining > 0 ? ` · +${remaining} more` : ''}`
  }
  return message
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
      // 'skipped' used to be silently dropped here. Two of the core's most
      // common outcomes — mid-turn, and "still finishing a provider switch" —
      // are skips, not failures, and a batch where every agent was busy would
      // otherwise print "Switched 0 agents" with no hint that anything was
      // even attempted.
      let skipped = 0
      // WHY the strings are kept rather than only counted: the core writes
      // messages that name the exact remedy (the poisoned-carrier abort) and
      // the exact loss (the shrink ladder's summary, added specifically so
      // "no lossy step is silent"). Bulk discarded both and printed
      // "Switched 0 agents to Claude (12 failed)" / "12 raw", which is
      // unactionable — a point the sibling model-switch function in the modal
      // already argues in its own comment. Deduped and capped, because twenty
      // agents usually fail for the same one reason.
      const notes = new Set<string>()
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

        // The tally counts exactly the agents the summary counts. A switch that
        // succeeded but lost its meta mid-loop is not in `switched`, so counting
        // its strategy would produce "Switched 2 agents to Claude: 3 native" —
        // a summary that contradicts itself.
        // Branch on status FIRST so each arm narrows cleanly. The old shape
        // folded `&& meta && originalKind` into the success test, which pushed
        // a switched-but-meta-less result into the skipped arm.
        if (result.status === 'failed') {
          failed += 1
          notes.add(result.message)
        } else if (result.status === 'skipped') {
          skipped += 1
          notes.add(result.reason)
        } else if (meta && originalKind) {
          counts[result.strategy] += 1
          if (result.shrinkSummary) notes.add(result.shrinkSummary)
          switched.push({
            sessionId: result.newSessionId,
            cwd: meta.cwd,
            originalKind,
            switchedToKind: targetKind,
            title: meta.title,
          })
        } else {
          // Switched, but its meta vanished mid-loop so it cannot be recorded
          // as a batch member. Counting its strategy would produce a summary
          // that contradicts itself ("Switched 2 agents: 3 native"), and
          // silently dropping it would under-report the work done.
          skipped += 1
          notes.add('An agent switched but was closed before it could be recorded')
        }
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
            // Recorded so Return can reuse this consent instead of deciding
            // for the user. See returnPolicy.
            compactOnArrival: policy.compactOnArrival,
          },
        }))
      }

      const tally = [
        counts.native > 0 ? `${counts.native} native` : null,
        counts.raw > 0 ? `${counts.raw} raw` : null,
        counts.shrunk > 0 ? `${counts.shrunk} shrunk` : null,
      ].filter(Boolean).join(', ')
      const base = `Switched ${pluralAgents(switched.length)} to ${providerLabel(targetKind)}${tally ? `: ${tally}` : ''}`
      showToast(summarize(base, { skipped, failed }, notes))
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
    const notes = new Set<string>()
    // Agents that did NOT make it home. See the batch update below for why
    // these have to survive: this modal is the only return affordance there is.
    const unreturned: typeof batch.agents = []

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

      const policy = returnPolicy(agent.originalKind, batch.compactOnArrival)
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
      if (result.status === 'switched') {
        returned += 1
        if (result.shrinkSummary) notes.add(result.shrinkSummary)
      } else if (result.status === 'failed') {
        failed += 1
        notes.add(result.message)
        unreturned.push(agent)
      } else {
        notes.add(result.reason)
        // 'skipped' here means the pane refused the switch right now — most
        // often "still finishing a provider switch". It is still sitting on
        // the target provider, so it is still returnable later.
        skipped += 1
        unreturned.push(agent)
      }
    }

    // WHY the batch is trimmed rather than dropped:
    //
    // "Returning consumes the batch" is right only for agents that actually
    // returned. Dropping it wholesale meant a return in which NOTHING came
    // back still destroyed the record, and this modal is the only return
    // affordance in the app — there is no other way to get those agents home.
    //
    // That is not a rare case. Arrival compaction is on by default whenever
    // the largest conversation exceeds 150k chars (the population this
    // feature exists for), and it holds `providerSwitch` set for the arrival
    // readiness wait plus the compaction wait — minutes per pane. Every agent
    // in a batch returned during that window is refused with "This pane is
    // still finishing a provider switch", so returned === 0, and the user
    // lost the batch by clicking the button that was supposed to restore it.
    // Partial returns lost the remainder the same way: 1 of 20 home, 19
    // records discarded.
    //
    // Keeping the unreturned agents means Return stays available and is
    // simply retried. The batch is cleared only once it is empty.
    setState(prev => {
      if (prev.lastProviderSwitchBatch?.id !== batch.id) return prev
      if (unreturned.length === 0) return { ...prev, lastProviderSwitchBatch: null }
      return {
        ...prev,
        lastProviderSwitchBatch: { ...prev.lastProviderSwitchBatch, agents: unreturned },
      }
    })

    const base = `Returned ${pluralAgents(returned)} to ${providerLabel(batch.sourceKind)}`
    showToast(summarize(base, { skipped, failed }, notes))
  }, [refs, sessionActions, setRuntimes, setState, showToast])

  return { switchAgentsToProvider, returnLastProviderSwitchBatch }
}
