import { isAgentSessionKind, isProcessSessionKind } from '@shared/types/providerKind'
import { commandTargetSessionIdForState } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import type { WorkspaceState } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'

/**
 * Resolves the pane that may receive a prompt template.
 *
 * WHY this is the shared command target and not narrower (#830):
 * terminal panes became valid template targets when insertion learned to
 * bracket-paste into any focused PTY via deliverTextToSession. The old
 * agent-only predicate hid the command from exactly the panes where
 * users run unsupported agent harnesses in a raw terminal.
 * Extension views have neither a composer nor a PTY, so they remain excluded.
 */
export function promptTemplateTargetSessionId(workspace: Workspace): string | null {
  return promptTemplateTargetSessionIdForState(workspace.state)
}

export function promptTemplateTargetSessionIdForState(state: WorkspaceState): string | null {
  const sessionId = commandTargetSessionIdForState(state)
  const meta = sessionId ? state.sessions[sessionId] : undefined
  return meta && isProcessSessionKind(meta.kind) ? sessionId : null
}

/**
 * Whether the target pane owns an agent composer whose DRAFT a command
 * can read. Terminal panes are valid delivery targets (#830) but have no
 * composer; commands like "save composer as template" stay hidden there.
 */
export function promptTemplateComposerSessionIdForState(state: WorkspaceState): string | null {
  const sessionId = commandTargetSessionIdForState(state)
  if (!sessionId) return null
  return isAgentSessionKind(state.sessions[sessionId]?.kind) ? sessionId : null
}
