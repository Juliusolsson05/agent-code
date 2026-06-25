import type { SessionId } from '@renderer/workspace/types'
import type { AgentProviderKind } from '@shared/types/providerKind'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { WorkspaceSetRuntimes } from '@renderer/workspace/hook/context'
import type { SessionActions } from '@renderer/workspace/hook/actions/session'
import { resumableProviderSessionId } from '@renderer/workspace/providerSessionIdentity'

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

export async function switchAgentProvider(params: {
  sessionId: SessionId
  targetKind: AgentProviderKind
  refs: WorkspaceRefs
  setRuntimes: WorkspaceSetRuntimes
  sessionActions: SessionActions
}): Promise<SwitchAgentProviderResult> {
  const { sessionId, targetKind, refs, setRuntimes, sessionActions } = params

  const meta = refs.stateRef.current.sessions[sessionId]
  if (!meta) return { status: 'skipped', reason: 'Session no longer exists' }

  const sourceKind = meta.kind ?? 'claude'
  if (sourceKind !== 'claude' && sourceKind !== 'codex') {
    return { status: 'skipped', reason: 'Only Claude and Codex panes can switch provider' }
  }
  // Defensive: a no-op direction. The bulk modal only enumerates source-kind
  // agents so this shouldn't fire there, but returning a switched/skip result
  // keeps the helper honest if a caller ever asks to "switch" to the same kind.
  if (sourceKind === targetKind) {
    return { status: 'skipped', reason: `Already on ${targetKind}` }
  }

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
      const newSessionId = await sessionActions.replaceSession(meta.cwd, {
        kind: targetKind,
        builtInMcpDomains: meta.builtInMcpDomains,
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
            draftImages: targetKind === 'claude' ? draftImages : [],
          },
        }
      })
      return { status: 'switched', newSessionId, targetKind }
    }

    // The translated target transcript must be created BEFORE we replace the
    // live pane. If translation fails, the current provider process should stay
    // untouched and the user should keep their running session instead of being
    // dropped into a dead pane.
    const result = await window.api.switchProvider({
      sourceKind,
      sourceProviderSessionId,
      cwd: meta.cwd,
    })

    const newSessionId = await sessionActions.replaceSession(meta.cwd, {
      kind: result.targetKind,
      resumeSessionId: result.targetProviderSessionId,
      builtInMcpDomains: meta.builtInMcpDomains,
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
  }
}
