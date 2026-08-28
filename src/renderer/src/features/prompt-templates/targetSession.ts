import { isAgentSessionKind } from '@shared/types/providerKind'
import { commandTargetSessionIdForState } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import type { WorkspaceState } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'

/**
 * Resolves the composer that may receive a prompt template.
 *
 * WHY this is narrower than the shared command target: terminal and
 * extension-view panes are real sessions and therefore valid targets for
 * lifecycle commands, but neither owns the agent composer that template
 * insertion edits. Keeping this predicate feature-owned and shared by both
 * command visibility and execution prevents a picker from advertising an action
 * that can only return silently.
 */
export function promptTemplateTargetSessionId(workspace: Workspace): string | null {
  return promptTemplateTargetSessionIdForState(workspace.state)
}

export function promptTemplateTargetSessionIdForState(state: WorkspaceState): string | null {
  const sessionId = commandTargetSessionIdForState(state)
  if (!sessionId) return null
  return isAgentSessionKind(state.sessions[sessionId]?.kind) ? sessionId : null
}
