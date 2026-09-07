import { useAppStore } from '@renderer/app-state/hooks'
import { applyPromptTemplateInsertMode } from '@renderer/features/prompt-templates/interpolate'
import { getEffectiveAgentSurfaceForSession } from '@renderer/workspace/agentDisplayMode'
import { isSessionExited } from '@renderer/workspace/providerSessionIdentity'
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
//     in terminal view) → bracketed paste via window.api.sendInput,
//     which is the SAME channel both surfaces use for keystrokes
//
// WHY no Enter on the PTY path: the user must review what landed before
// it executes. Bracketed paste markers additionally keep shells like
// zsh from executing multi-line payloads line-by-line. Trade-off: a
// program that never enabled bracketed paste mode will print the marker
// bytes — acceptable versus the alternative of raw newlines, which a
// shell would run immediately.

export type DeliverTextResult =
  | { delivered: true; surface: 'composer' | 'pty' }
  | { delivered: false; reason: 'no-session' }

export async function deliverTextToSession(
  workspace: Workspace,
  sessionId: SessionId,
  text: string,
  opts?: { insertMode?: 'replace' | 'append' },
): Promise<DeliverTextResult> {
  const session = workspace.state.sessions[sessionId]
  if (!session) return { delivered: false, reason: 'no-session' }

  if (session.kind !== 'terminal') {
    const surface = getEffectiveAgentSurfaceForSession({
      kind: session.kind,
      providerRuntime: session.providerRuntime,
      globalMode: useAppStore.getState().settings.agentViewMode,
      override: session.agentViewModeOverride,
      runtime: workspace.getRuntime(sessionId),
    })
    if (surface === 'rendered') {
      const currentDraft = workspace.getRuntime(sessionId).draftInput
      workspace.setDraftInput(
        sessionId,
        applyPromptTemplateInsertMode(currentDraft, text, opts?.insertMode ?? 'append'),
      )
      return { delivered: true, surface: 'composer' }
    }
  }
  return deliverPtyText(workspace, sessionId, text)
}

async function deliverPtyText(
  workspace: Workspace,
  sessionId: SessionId,
  text: string,
): Promise<DeliverTextResult> {
  const runtime = workspace.getRuntime(sessionId)
  // WHY wake first: lazily-woken restored sessions may have no main-side
  // backend yet, and sendInput into a missing backend is silently
  // dropped. Same predicate and no input-ready wait as AgentTerminalLeaf
  // (#772): readiness is a composer concept, not a PTY one.
  if (runtime.processStatus !== 'started' || isSessionExited(runtime)) {
    await workspace.ensureSessionLive(sessionId, 'session-text-delivery', { awaitInputReady: false })
  }
  await window.api.sendInput(sessionId, `\x1b[200~${text}\x1b[201~`)
  return { delivered: true, surface: 'pty' }
}
