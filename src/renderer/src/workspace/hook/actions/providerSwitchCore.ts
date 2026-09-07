// See docs/design/provider-switching.md for the renderer/main transaction,
// progress, and non-cancellable compaction lock invariants.
import type { SessionId } from '@renderer/workspace/types'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type { AgentProviderKind, AgentProviderRuntime } from '@shared/types/providerKind'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { WorkspaceSetRuntimes } from '@renderer/workspace/hook/context'
import type { SessionActions } from '@renderer/workspace/hook/actions/session'
import { resumableProviderSessionId } from '@renderer/workspace/providerSessionIdentity'
import { resolveSessionBuiltInMcpDomains } from '@renderer/workspace/mcpDomains'
import {
  providerChoiceLabel,
  providerSwitchChoices,
} from '@renderer/workspace/providerChoices'

// Single-agent provider switch — the shared core.
//
// WHY this exists as a standalone function instead of living inside
// `switchSessionProvider`: two callers now need the exact same "translate this
// agent's transcript and re-home its pane onto a target provider" operation —
// the focused-pane command (provider.ts) and the bulk Switch Agents modal
// (bulkProviderSwitch.ts). Duplicating the two-branch translate/replace logic
// would be a correctness hazard: the empty-pane special case and the
// draftImages handling are subtle, and a copy would drift. So the mechanics
// live here once; callers own only their own UX (which pane to target, what
// toast to show, how to summarize a batch).
//
// The function is direction-EXPLICIT: the caller passes `targetKind`. The
// focused picker chooses one explicit provider/runtime destination; the bulk
// modal chooses an explicit provider direction for the whole batch. Keeping the
// helper agnostic means the policy lives with the caller, not buried in here.
//
// It never throws — every outcome is a discriminated result so the bulk caller
// can tally switched / skipped / failed for its summary without a try/catch per
// agent.

export type SwitchAgentProviderResult =
  | {
      status: 'switched'
      newSessionId: SessionId
      targetKind: AgentProviderKind
      /** How the conversation was made to fit the target, straight from the
       *  transaction: `native` lost nothing, `raw` dropped only a carrier the
       *  target could not have read, `shrunk` removed content the ladder had
       *  to remove. The bulk caller counts these; the single-pane caller shows
       *  the one it got. */
      strategy: SwitchStrategy
      /** One human-readable line describing what `shrunk` cost, else null. */
      shrinkSummary: string | null
    }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; message: string }

export type SwitchStrategy = 'native' | 'raw' | 'shrunk'

/**
 * Is this pane parked on a provider usage limit rather than genuinely working?
 *
 * WHY the switch guard needs an exception at all: both providers keep their
 * process alive while a usage window is exhausted — Claude paints "Usage limit
 * reached · continuing automatically" and waits, Codex keeps the conversation
 * open after its 429. `processActive` therefore stays true for the exact
 * population this feature exists to rescue, and the pre-existing guard
 * ("Wait for the current turn to finish") would refuse every one of them.
 *
 * WHY the comparison is against `turnStartedAt` and not a wall-clock age: a
 * limit hit older than the current turn's start belongs to a previous episode
 * the user already worked past, and switching then would kill a live turn.
 * `turnStartedAt === null` (restored/detached panes that never ran the stream
 * phase machine) means there is no turn to protect, so the limit signal stands
 * on its own.
 *
 * CAVEAT, deliberately shipped: whether `processActive` in fact stays true
 * under Claude's auto-wait banner is Unknown 1 in the decomposition and has NO
 * recording yet (docs/decomposition/quota-independent-provider-switch.md,
 * Stage 6). This predicate is therefore DEFENSIVE, not evidence-driven: if the
 * banner turns out to clear `processActive`, the guard already lets the switch
 * through on the ordinary idle path and this exception is simply never
 * consulted. It can only widen the guard, never narrow it, so being wrong
 * about the banner costs nothing.
 */
export function isLimitIdle(
  runtime: Pick<SessionRuntime, 'limitHit' | 'turnStartedAt'>,
): boolean {
  return (
    runtime.limitHit !== null &&
    (runtime.turnStartedAt === null || runtime.limitHit.at >= runtime.turnStartedAt)
  )
}

// WHY this is module-scoped rather than React state: the lock guards an
// imperative cross-process transaction and should become visible to a second
// command invocation synchronously, without waiting for a render. Main holds a
// matching lock as the authority; this one provides immediate pane feedback.
const providerSwitchesInFlight = new Set<SessionId>()

export async function switchAgentProvider(params: {
  sessionId: SessionId
  targetKind: AgentProviderKind
  targetProviderRuntime?: AgentProviderRuntime
  refs: WorkspaceRefs
  setRuntimes: WorkspaceSetRuntimes
  sessionActions: SessionActions
  /**
   * What this switch may spend to make the conversation portable. Both halves
   * default to false in main (DEFAULT_SWITCH_CONTEXT_POLICY); the caller that
   * owns the UI decides. `compactOnArrival` is acted on HERE rather than by the
   * transaction, because the pane it applies to does not exist until
   * `replaceSession` returns.
   */
  contextPolicy?: {
    allowSourceTurns?: boolean
    compactOnArrival?: boolean
  }
  /**
   * The caller already confirmed that compacting the LIVE source is
   * acceptable, so main skips its per-agent native dialog.
   *
   * WHY the confirmation travels beside the policy instead of being implied by
   * `allowSourceTurns`: a batch of twenty agents must be confirmed ONCE, in the
   * modal, and a per-agent modal dialog twenty deep is the behavior this
   * feature removes (spec §Renderer, "One confirmation per batch"). Only
   * meaningful with `allowSourceTurns: true`; main ignores it otherwise.
   */
  sourceCompactionConfirmed?: boolean
  onProgress?: (event: {
    phase: 'compacting' | 'summarizing' | 'shrinking' | 'projecting'
    message: string
  }) => void
  /**
   * Arrival compaction failed. Separate from the result because the switch
   * itself already succeeded and this fires long after this function returned;
   * the caller decides whether one agent's failed tidy-up is worth a toast.
   */
  onArrivalFailure?: (message: string) => void
}): Promise<SwitchAgentProviderResult> {
  const {
    sessionId,
    targetKind,
    targetProviderRuntime,
    refs,
    setRuntimes,
    sessionActions,
    contextPolicy,
    sourceCompactionConfirmed,
    onProgress,
    onArrivalFailure,
  } = params

  const meta = refs.stateRef.current.sessions[sessionId]
  if (!meta) return { status: 'skipped', reason: 'Session no longer exists' }

  const sourceKind = meta.kind ?? DEFAULT_PROVIDER
  if (!isAgentProviderKind(sourceKind)) {
    return { status: 'skipped', reason: 'Only agent panes can switch provider' }
  }
  const declaredChoice = providerSwitchChoices(sourceKind).some(choice => (
    choice.kind === targetKind && choice.providerRuntime === targetProviderRuntime
  ))
  if (!declaredChoice) {
    // WHY validate again below the picker: commands are also reachable from
    // native menus, keybindings, tests, and future automation. The modal is a
    // presentation convenience, not authority. Rejecting before export keeps
    // an impossible/stale edge from producing a durable target transcript that
    // no pane can safely adopt.
    return {
      status: 'skipped',
      reason: `${providerChoiceLabel(targetKind, targetProviderRuntime)} is not a switch destination for ${sourceKind}`,
    }
  }

  const resolveTargetBuiltInMcpDomains = (
    effectiveSourceDomains: unknown,
    effectiveTargetKind: AgentProviderKind,
  ) => resolveSessionBuiltInMcpDomains({
    provider: effectiveTargetKind,
    // WHY original undefined provenance bypasses the source-filtered value:
    // this legacy pane has never captured a per-session choice, so the target
    // provider must seed current Settings. Once a list exists, including [],
    // it is authoritative and only its source-supported subset may cross.
    sessionDomains:
      meta.builtInMcpDomains === undefined ? undefined : effectiveSourceDomains,
    defaultDomains: refs.defaultBuiltInMcpDomainsRef.current,
  })

  const replaceTranscriptlessPane = async (): Promise<SwitchAgentProviderResult> => {
    // A freshly-spawned pane can be transcript-less either because its
    // provider has not announced a durable id yet (Claude/Codex) OR because it
    // deliberately pre-created an empty durable session (OpenCode Terminal).
    // Both states need the same pane replacement. Keeping that operation in
    // one closure prevents the two identity models from drifting on draft and
    // MCP-domain preservation.
    const effectiveSourceDomains =
      meta.builtInMcpDomains === undefined
        ? undefined
        : resolveSessionBuiltInMcpDomains({
            provider: sourceKind,
            sessionDomains: meta.builtInMcpDomains,
            defaultDomains: [],
          })
    const newSessionId = await sessionActions.replaceSession(meta.cwd, {
      kind: targetKind,
      ...(targetProviderRuntime ? { providerRuntime: targetProviderRuntime } : {}),
      builtInMcpDomains: resolveTargetBuiltInMcpDomains(
        effectiveSourceDomains,
        targetKind,
      ),
      // Pin the replacement to THIS agent. Without it, bulk switching can
      // replace whichever pane became focused while an earlier conversion was
      // awaiting main-process work.
      targetSessionId: sessionId,
    })
    if (!newSessionId) return { status: 'failed', message: 'Replacement failed' }

    // The replacement owner transfers the latest supported draft atomically.
    // A second snapshot here would overwrite edits made while spawn awaited.
    //
    // `native` is the honest strategy for an empty source: no transcript was
    // translated, so nothing could be lost. Reporting null instead would make
    // the batch tally under-count agents that switched perfectly well.
    return { status: 'switched', newSessionId, targetKind, strategy: 'native', shrinkSummary: null }
  }

  const sourceRuntime = refs.latestRuntimesRef.current[sessionId]
  // The usage-limit exception (see isLimitIdle): a pane whose provider is
  // sitting on an exhausted window still reads as busy, and refusing it would
  // lock out precisely the agents this feature exists to move. Replacement
  // kills the process, which is what ends the provider's wait banner anyway.
  if ((sourceRuntime?.processActive || sourceRuntime?.semantic.currentTurn) && !(sourceRuntime && isLimitIdle(sourceRuntime))) {
    return { status: 'failed', message: 'Wait for the current turn to finish before switching provider' }
  }
  if (providerSwitchesInFlight.has(sessionId)) {
    return { status: 'failed', message: 'Provider switch already in progress' }
  }
  providerSwitchesInFlight.add(sessionId)
  setRuntimes(prev => {
    const runtime = prev[sessionId]
    if (!runtime) return prev
    return {
      ...prev,
      [sessionId]: {
        ...runtime,
        providerSwitch: {
          phase: 'preparing',
          message: `Preparing switch to ${targetKind}…`,
        },
      },
    }
  })

  try {
    const sourceProviderSessionId = resumableProviderSessionId(meta)
    if (!sourceProviderSessionId) {
      // A freshly-spawned provider pane has no durable provider transcript yet.
      // Claude's sessionId and Codex's session_meta only reach SessionMeta
      // after the first provider JSONL/rollout entry arrives (usually after the
      // first user submission). Calling main-process conversion here would be
      // both conceptually wrong (no persisted conversation to translate) and
      // mechanically brittle (the converter derives the target resume id from
      // transcript records that don't exist yet). The user's intent in this
      // state is "I opened the wrong provider before starting", so a no-resume
      // replacement is the faithful operation.
      //
      return await replaceTranscriptlessPane()
    }

    // WHY a durable pane is woken before main plans the transcript conversion:
    // restored and Dispatch-detached panes intentionally outlive their provider
    // process. Their SessionMeta still has everything needed to resume, so they
    // look switchable in the UI, but main no longer has a registry entry under
    // the pane id. That only becomes visible after transcript planning decides
    // native compaction is required, where the old code failed with the opaque
    // "source agent changed or exited" ownership guard. Recover under the SAME
    // renderer id first. Besides making hibernated panes switchable, this keeps
    // the compaction guard meaningful: any kind/cwd mismatch observed after
    // recovery is a real mid-transaction ownership change, not ordinary pane
    // hibernation. `ensureSessionLive` is idempotent for an already-live owner
    // and main's recovery claim serializes concurrent wake attempts.
    const wakeResult = await sessionActions.ensureSessionLive(sessionId, 'provider-switch.wake-source')

    // The translated target transcript must be created BEFORE we replace the
    // live pane. If translation fails, the current provider process should stay
    // untouched and the user should keep their running session instead of being
    // dropped into a dead pane.
    const unsubscribeProgress = window.api.onProviderSwitchProgress(event => {
      if (event.sourceSessionId !== sessionId) return
      setRuntimes(prev => {
        const runtime = prev[sessionId]
        if (!runtime) return prev
        return {
          ...prev,
          [sessionId]: {
            ...runtime,
            providerSwitch: {
              phase: event.phase,
              message: event.message,
            },
          },
        }
      })
      onProgress?.({ phase: event.phase, message: event.message })
    })
    const result = await window.api.switchProvider({
      sourceKind,
      // Explicit target (#394 phase 5a). This helper always KNEW the
      // target — its callers pass it — but historically dropped it
      // before IPC and relied on main's two-provider negation. With
      // the negation slated for removal, the renderer's choice is now
      // authoritative end-to-end.
      targetKind,
      sourceProviderSessionId,
      sourceSessionId: sessionId,
      cwd: meta.cwd,
      // A policy the caller passed and this function silently dropped would be
      // a trap for the caller that sets `allowSourceTurns` and wonders why the
      // source was never asked to compact. Both keys are spread conditionally
      // so an unset policy still reaches main as "absent", letting
      // DEFAULT_SWITCH_CONTEXT_POLICY stay the single source of the defaults.
      ...(contextPolicy ? { contextPolicy } : {}),
      ...(sourceCompactionConfirmed ? { sourceCompactionConfirmed } : {}),
    }).finally(unsubscribeProgress)

    if (result.kind === 'source-empty') {
      return await replaceTranscriptlessPane()
    }

    // WHY target domains distinguish legacy `undefined` from an explicit list:
    // waking initializes renderer metadata under the SOURCE provider. A legacy
    // undefined Claude pane can therefore become `[]` merely because its
    // configured default is Codex-only Workflow MCP; that must still seed the
    // Codex target. Conversely, a stale explicit `['workflows']` is narrowed
    // to `[]` during the Claude wake and must not be resurrected just because
    // Codex supports it. Preserve original initialization provenance, but use
    // the post-wake list for every session that already had an explicit policy.
    const targetBuiltInMcpDomains = resolveTargetBuiltInMcpDomains(
      wakeResult.builtInMcpDomains,
      result.targetKind,
    )
    const newSessionId = await sessionActions.replaceSession(meta.cwd, {
      kind: result.targetKind,
      ...(targetProviderRuntime ? { providerRuntime: targetProviderRuntime } : {}),
      resumeSessionId: result.targetProviderSessionId,
      builtInMcpDomains: targetBuiltInMcpDomains,
      // See the empty-pane branch above: pin to this agent so the bulk loop
      // replaces the right pane (not the focused one) and the single-pane
      // caller is immune to focus changing during the translate await.
      targetSessionId: sessionId,
    })
    if (!newSessionId) return { status: 'failed', message: 'Replacement failed' }

    if (contextPolicy?.compactOnArrival && result.targetKind === 'claude') {
      // WHY this one call is wrapped when the whole body is already inside a
      // try: this statement runs AFTER `replaceSession` succeeded, and the
      // outer catch turns anything thrown into `{ status: 'failed' }` — which
      // would report a committed switch as failed because a follow-up could not
      // start. A synchronous throw here (a missing `window.api.compactAfterSwitch`
      // on an older preload, a subscribe that rejects) would also leak the
      // progress subscription. Contain it and tell the caller through the same
      // channel every other arrival failure uses.
      try {
        startArrivalCompaction({
          sessionId: newSessionId,
          cwd: meta.cwd,
          providerSessionId: result.targetProviderSessionId,
          setRuntimes,
          onArrivalFailure,
        })
      } catch (arrivalError) {
        onArrivalFailure?.(
          arrivalError instanceof Error && arrivalError.message.length > 0
            ? arrivalError.message
            : 'Arrival compaction could not be started',
        )
      }
    }

    return {
      status: 'switched',
      newSessionId,
      targetKind: result.targetKind,
      strategy: result.strategy,
      shrinkSummary: result.shrinkSummary,
    }
  } catch (err) {
    const message =
      err instanceof Error && err.message.length > 0 ? err.message : 'Provider switch failed'
    return { status: 'failed', message }
  } finally {
    providerSwitchesInFlight.delete(sessionId)
    setRuntimes(prev => {
      const runtime = prev[sessionId]
      if (!runtime || runtime.providerSwitch === null) return prev
      return {
        ...prev,
        [sessionId]: { ...runtime, providerSwitch: null },
      }
    })
  }
}

/**
 * Ask the freshly replaced pane to compact its imported history with the
 * TARGET's quota, and show its progress on that pane.
 *
 * WHY fire-and-forget rather than awaited: a batch of twenty agents must not
 * serialize twenty Claude compactions, each of which can run for minutes. The
 * switch is already committed and its result is already the caller's; this is
 * an independent follow-up whose only user-visible outputs are the pane banner
 * below and, on failure, one toast.
 *
 * WHY a second progress subscription instead of reusing the one in
 * `switchAgentProvider`: that one filters on the SOURCE session id and is
 * unsubscribed the moment the transaction resolves — which is before
 * `replaceSession` has even created the id this progress is addressed to. The
 * subscription is torn down when the arrival promise settles, which is the only
 * honest terminator: the progress channel has no "done" event.
 */
function startArrivalCompaction(params: {
  sessionId: SessionId
  cwd: string
  providerSessionId: string
  setRuntimes: WorkspaceSetRuntimes
  onArrivalFailure?: (message: string) => void
}): void {
  const { sessionId, cwd, providerSessionId, setRuntimes, onArrivalFailure } = params
  const unsubscribeProgress = window.api.onProviderSwitchProgress(event => {
    if (event.sourceSessionId !== sessionId) return
    setRuntimes(prev => {
      const runtime = prev[sessionId]
      if (!runtime) return prev
      return {
        ...prev,
        [sessionId]: {
          ...runtime,
          providerSwitch: { phase: event.phase, message: event.message },
        },
      }
    })
  })
  // The subscription is live from here on, so a synchronous throw out of the
  // IPC call (an older preload with no `compactAfterSwitch`) has to take it
  // down before the caller's catch reports the failure — otherwise the pane
  // keeps a listener that nothing will ever unsubscribe.
  let pending: ReturnType<typeof window.api.compactAfterSwitch>
  try {
    pending = window.api.compactAfterSwitch({
      sessionId,
      targetKind: 'claude',
      cwd,
      providerSessionId,
    })
  } catch (error) {
    unsubscribeProgress()
    throw error
  }
  void pending
    .then(outcome => {
      if (!outcome.ok) onArrivalFailure?.(outcome.message)
    })
    // The handler reports failures in its result, so a rejection here means the
    // IPC boundary itself broke. Catch it anyway: an unhandled rejection from a
    // deliberately un-awaited promise is a console error with no owner.
    .catch(error => {
      onArrivalFailure?.(
        error instanceof Error && error.message.length > 0
          ? error.message
          : 'Arrival compaction failed',
      )
    })
    .finally(() => {
      unsubscribeProgress()
      setRuntimes(prev => {
        const runtime = prev[sessionId]
        if (!runtime || runtime.providerSwitch === null) return prev
        return {
          ...prev,
          [sessionId]: { ...runtime, providerSwitch: null },
        }
      })
    })
}
