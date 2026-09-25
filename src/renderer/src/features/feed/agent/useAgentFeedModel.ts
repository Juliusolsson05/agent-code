import { useMemo } from 'react'

import type { AgentProviderKind } from '@shared/types/providerKind'
import type { ProviderConditionSnapshot, ClaudeAskUserQuestionState } from '@shared/types/providerConditions'
import { conditionStateByKind } from '@shared/types/providerConditions'
import type { SubAgentState } from '@shared/sessionFeed/types'
import type { Entry } from '@shared/types/transcript'
import type { RuntimeRenderInput, SessionRuntime } from '@renderer/session-runtime/state'
import { selectMergedEntries } from '@renderer/session-runtime/mergedEntries'
import { useLedgerFeedItems } from '@renderer/features/feed/ledger/useLedgerFeedItems'
import type { LedgerFeedPlan } from '@renderer/features/feed/ledger/useLedgerFeedItems'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'

// The runtime → paint mapping every agent feed shares (#1177).
//
// WHY this exists. TileLeaf turned a SessionRuntime into Feed props and a
// condition snapshot; the phone's SessionView did the same by hand, citing
// TileLeaf's line numbers so it could be kept "in step". It was not: the
// phone painted raw entries instead of the merged ghost fallback, drew the
// raw condition snapshot instead of the provider-normalized one, and
// distinguished "no snapshot yet" from "snapshot without a question"
// differently. This hook is the one mapping; both surfaces call it, and the
// AgentFeed / AgentConditionOutlet components paint what it returns.
//
// It takes a runtime SLICE, not SessionRuntime, because the phone has no
// full runtime (no queue, no drafts, no workspace fields) and must never be
// asked to fabricate one. Everything below is what a feed needs to paint.

export type AgentFeedRuntime = RuntimeRenderInput &
  Pick<
    SessionRuntime,
    | 'turnStartedAt'
    | 'toolUseIndex'
    | 'toolResultIndex'
    | 'toolIndexVersion'
    | 'conditions'
    | 'hasOlderHistory'
    | 'loadingOlderHistory'
    | 'bootstrapping'
  > & {
    /** Null until a host has observed a fleet (the phone before its first
     *  sub-agents frame). Feed treats absent and empty alike. */
    subAgents: Record<string, SubAgentState> | null
  }

export type AgentFeedModel = {
  /** The ownership ledger's decided rows. TileLeaf also reads these for its
   *  visible-submit evidence, which is why the model is a hook the surface
   *  holds rather than state hidden inside the Feed component. */
  ledgerFeedPlan: LedgerFeedPlan
  /** Committed entries plus the rare orphan-ghost fallback (see
   *  selectMergedEntries / docs/design/ghost-system.md). Identical to
   *  `entries` on a host without ghosts. */
  mergedEntries: Entry[]
  /** The snapshot after the provider's own normalization (Claude folds
   *  compaction state into it); what the outlet must draw. */
  normalizedConditions: ProviderConditionSnapshot | null
  /** undefined = no snapshot yet; null = snapshot positively without the
   *  question. Feed distinguishes the two. */
  askUserQuestionState: ClaudeAskUserQuestionState | null | undefined
}

export function useAgentFeedModel(
  runtime: AgentFeedRuntime,
  provider: AgentProviderKind,
  sessionId: string,
): AgentFeedModel {
  const ledgerFeedPlan = useLedgerFeedItems(runtime, provider, sessionId, {
    toolUseIndex: runtime.toolUseIndex,
    toolResultIndex: runtime.toolResultIndex,
    version: runtime.toolIndexVersion,
  })
  const currentTurnId = runtime.semantic.currentTurn?.turnId ?? null
  const mergedEntries = useMemo(
    () => selectMergedEntries(runtime, currentTurnId),
    // The predicate reads exactly these planes; keying on the runtime object
    // would recompute on every unrelated runtime write (drafts, queue).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runtime.entries, runtime.ghosts, runtime.lastJsonlEntryAt, currentTurnId, runtime.semantic.history],
  )
  const normalizedConditions = useMemo(() => {
    const normalize = getRendererProviderCapabilities(provider).normalizeConditions
    return normalize
      ? normalize({
          snapshot: runtime.conditions,
          currentTurn: runtime.semantic.currentTurn,
          entries: runtime.entries,
        })
      : runtime.conditions
  }, [provider, runtime.conditions, runtime.entries, runtime.semantic.currentTurn])
  // Kind-keyed lookup (#394 phase 3): globally namespaced kinds make a
  // provider narrow redundant.
  const askUserQuestionState = useMemo(
    () =>
      runtime.conditions
        ? conditionStateByKind<ClaudeAskUserQuestionState>(runtime.conditions, 'claude.ask-user-question')
        : undefined,
    [runtime.conditions],
  )
  return { ledgerFeedPlan, mergedEntries, normalizedConditions, askUserQuestionState }
}
