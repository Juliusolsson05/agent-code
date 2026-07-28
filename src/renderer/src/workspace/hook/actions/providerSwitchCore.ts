// See docs/design/provider-switching.md for the renderer/main transaction,
// progress, and non-cancellable compaction lock invariants.
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import type { SessionId } from '@renderer/workspace/types'
import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type { AgentProviderKind } from '@shared/types/providerKind'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { WorkspaceSetRuntimes } from '@renderer/workspace/hook/context'
import type { SessionActions } from '@renderer/workspace/hook/actions/session'
import { resumableProviderSessionId } from '@renderer/workspace/providerSessionIdentity'
import { resolveSessionBuiltInMcpDomains } from '@renderer/workspace/mcpDomains'

// Single-agent provider switch — the shared core.
//
// WHY this exists as a standalone function instead of living inside
// `switchFocusedProvider`: two callers now need the exact same "translate this
// agent's transcript and re-home its pane onto the other provider" operation —
// the focused-pane command (provider.ts) and the bulk Switch Agents modal
// (bulkProviderSwitch.ts). Duplicating the two-branch translate/replace logic
// would be a correctness hazard: the empty-pane special case and the
// draftImages handling are subtle, and a copy would drift. So the mechanics
// live here once; callers own only their own UX (which pane to target, what
// toast to show, how to summarize a batch).
//
// The function is direction-EXPLICIT: the caller passes `targetKind`. The
// focused command computes that as "the other provider"; the bulk modal forces
// a fixed direction for the whole batch. Keeping the helper agnostic means the
// policy lives with the caller, not buried in here.
//
// It never throws — every outcome is a discriminated result so the bulk caller
// can tally switched / skipped / failed for its summary without a try/catch per
// agent.

export type SwitchAgentProviderResult =
  | { status: 'switched'; newSessionId: SessionId; targetKind: AgentProviderKind }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; message: string }

// WHY this is module-scoped rather than React state: the lock guards an
// imperative cross-process transaction and should become visible to a second
// command invocation synchronously, without waiting for a render. Main holds a
// matching lock as the authority; this one provides immediate pane feedback.
const providerSwitchesInFlight = new Set<SessionId>()

export async function switchAgentProvider(params: {
  sessionId: SessionId
  targetKind: AgentProviderKind
  refs: WorkspaceRefs
  setRuntimes: WorkspaceSetRuntimes
  sessionActions: SessionActions
  onProgress?: (event: {
    phase: 'compacting' | 'summarizing' | 'projecting'
    message: string
  }) => void
}): Promise<SwitchAgentProviderResult> {
  const { sessionId, targetKind, refs, setRuntimes, sessionActions, onProgress } = params

  const meta = refs.stateRef.current.sessions[sessionId]
  if (!meta) return { status: 'skipped', reason: 'Session no longer exists' }

  const sourceKind = meta.kind ?? DEFAULT_PROVIDER
  if (!isAgentProviderKind(sourceKind)) {
    return { status: 'skipped', reason: 'Only Claude and Codex panes can switch provider' }
  }
  // Defensive: a no-op direction. The bulk modal only enumerates source-kind
  // agents so this shouldn't fire there, but returning a switched/skip result
  // keeps the helper honest if a caller ever asks to "switch" to the same kind.
  if (sourceKind === targetKind) {
    return { status: 'skipped', reason: `Already on ${targetKind}` }
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

  const sourceRuntime = refs.latestRuntimesRef.current[sessionId]
  if (sourceRuntime?.processActive || sourceRuntime?.semantic.currentTurn) {
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
      // `replaceSession` already preserves draftInput because several
      // replacement flows want typed-but-unsent text to survive. It does not
      // preserve draftImages, and broadening that helper would change
      // reload/rewind/resume semantics. Image drafts are still part of the
      // user's unsent empty-pane state, so this branch snapshots and restores
      // them explicitly — but only when the target provider can render them.
      const draftImages = refs.latestRuntimesRef.current[sessionId]?.draftImages ?? []
      // No durable transcript means there is nothing for ensureSessionLive to
      // recover, but provider policy still applies. Filtering the explicit
      // source list first prevents stale Claude `workflows` metadata from
      // becoming valid merely because the target Codex provider supports it.
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
        builtInMcpDomains: resolveTargetBuiltInMcpDomains(
          effectiveSourceDomains,
          targetKind,
        ),
        // Pin the replacement to THIS agent. Without it, replaceSession falls
        // back to the current command target (the focused pane) — fine when the
        // caller IS the focused agent, but fatal for the bulk loop, which
        // switches agents that are not focused and would otherwise replace the
        // focused pane N times. Pinning also closes a latent race in the
        // single-pane caller: focus can change during the translate await
        // below, and we want to replace the pane we validated, not whatever is
        // focused when the await resolves. (Same reason rewind pins its target.)
        targetSessionId: sessionId,
      })
      if (!newSessionId) return { status: 'failed', message: 'Replacement failed' }

      setRuntimes(prev => {
        const runtime = prev[newSessionId]
        if (!runtime) return prev
        return {
          ...prev,
          [newSessionId]: {
            ...runtime,
            // Codex panes do not render or submit draft image attachments.
            // Carrying Claude-only image state into a Codex runtime would be
            // worse than a visible drop: the hidden array still participates in
            // the composer "empty submit" guard, so pressing Enter on an
            // apparently empty Codex composer could submit a blank prompt.
            draftImages: getRendererProviderCapabilities(targetKind).supportsImageAttachments ? draftImages : [],
          },
        }
      })
      return { status: 'switched', newSessionId, targetKind }
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
    }).finally(unsubscribeProgress)

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
      resumeSessionId: result.targetProviderSessionId,
      builtInMcpDomains: targetBuiltInMcpDomains,
      // See the empty-pane branch above: pin to this agent so the bulk loop
      // replaces the right pane (not the focused one) and the single-pane
      // caller is immune to focus changing during the translate await.
      targetSessionId: sessionId,
    })
    if (!newSessionId) return { status: 'failed', message: 'Replacement failed' }

    return { status: 'switched', newSessionId, targetKind: result.targetKind }
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
