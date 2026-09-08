import { useAppStore } from '@renderer/app-state/hooks'
import { applyPromptTemplateInsertMode } from '@renderer/features/prompt-templates/interpolate'
import { getEffectiveAgentSurfaceForSession } from '@renderer/workspace/agentDisplayMode'
import { isSessionExited } from '@renderer/workspace/providerSessionIdentity'
import { DEFAULT_PROVIDER } from '@shared/types/providerKind'
import { getTerminalPasteTarget } from '@renderer/workspace/terminal/textPasteTarget'
import type { SessionId } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'

// Session text delivery (#830): the ONE routing point for programmatic
// text insertion into a pane. Prompt Templates and the API Key Vault
// both call this instead of hand-rolling per-feature paths.
//
// Dispatch rule — mirror what the user sees:
//   * rendered agent surface → composer draft edit (never submits; the
//     draft stays visible and editable, matching template insertion's
//     "prefill, don't replay" contract)
//   * anything with a visible PTY (plain terminal pane, or agent pane
//     in terminal view) -> paste through that mounted terminal owner,
//     which checks its live paste mode and attach/replay state.
//
// WHY no Enter on the PTY path: the user must review what landed before
// it executes. Bracketed paste markers additionally keep shells like
// zsh from executing multi-line payloads line-by-line. A program that has
// not enabled bracketed paste receives single-line text only. Multiline
// input is refused rather than risking accidental command execution.
//
// SECRET DISCLOSURE (review finding): text inserted into a composer
// draft follows the SAME persistence rules as any draft — it autosaves
// to workspace.json in plaintext until sent or cleared. Inserted into a
// PTY it lands in scrollback (and tmux history). That is inherent to
// insertion itself, not this helper: once the user submits, the secret
// reaches the provider transcript in plaintext anyway. The VAULT's
// encryption contract covers storage, not the prompt pipeline.

export type DeliverTextResult =
  | { delivered: true; surface: 'composer' | 'pty' }
  | { delivered: false; reason: 'no-session' | 'write-rejected' | 'cancelled' }

export async function deliverTextToSession(
  workspace: Workspace,
  sessionId: SessionId,
  text: string,
  opts?: { insertMode?: 'replace' | 'append'; isCurrent?: () => boolean },
): Promise<DeliverTextResult> {
  if (opts?.isCurrent && !opts.isCurrent()) return { delivered: false, reason: 'cancelled' }
  const session = workspace.state.sessions[sessionId]
  if (!session) return { delivered: false, reason: 'no-session' }

  // WHY normalize kind (review finding): legacy persisted sessions may
  // lack `kind`. TileTree normalizes missing kinds to the default agent
  // provider before asking the surface policy; doing the same here keeps
  // this helper's dispatch identical to what the pane actually renders —
  // an undefined kind must not silently mean "rendered".
  const kind = session.kind ?? DEFAULT_PROVIDER

  if (kind !== 'terminal') {
    const surface = getEffectiveAgentSurfaceForSession({
      kind,
      providerRuntime: session.providerRuntime,
      globalMode: useAppStore.getState().settings.agentViewMode,
      override: session.agentViewModeOverride,
      runtime: workspace.getRuntime(sessionId),
    })
    if (surface === 'rendered') {
      const currentDraft = workspace.getRuntime(sessionId).draftInput
      workspace.setDraftInput(
        sessionId,
        opts?.insertMode ? applyPromptTemplateInsertMode(currentDraft, text, opts.insertMode) : currentDraft + text,
      )
      return { delivered: true, surface: 'composer' }
    }
  }
  return deliverPtyText(workspace, sessionId, text, opts?.isCurrent)
}

async function deliverPtyText(
  workspace: Workspace,
  sessionId: SessionId,
  text: string,
  isCurrent?: () => boolean,
): Promise<DeliverTextResult> {
  const runtime = workspace.getRuntime(sessionId)
  const target = getTerminalPasteTarget(sessionId)
  if (!target) return { delivered: false, reason: 'write-rejected' }
  // WHY wake first: lazily-woken restored sessions may have no main-side
  // backend yet, and sendInput into a missing backend is silently
  // dropped. Same predicate and no input-ready wait as AgentTerminalLeaf
  // (#772): readiness is a composer concept, not a PTY one.
  if (runtime.processStatus !== 'started' || isSessionExited(runtime)) {
    await workspace.ensureSessionLive(sessionId, 'session-text-delivery', { awaitInputReady: false })
  }
  // Auth/picker lifetime can end DURING wake. Checking only in the caller
  // would still paste after Escape or Lock now if the backend starts late.
  if (isCurrent && !isCurrent()) return { delivered: false, reason: 'cancelled' }
  // Do not follow a changed/mirrored target after wake or retry into a
  // replacement process. A refused write keeps the picker open for the user.
  if (getTerminalPasteTarget(sessionId) === target && await target.paste(text)) {
    return { delivered: true, surface: 'pty' }
  }
  return { delivered: false, reason: 'write-rejected' }
}
