import { DEFAULT_PROVIDER } from '@shared/types/providerKind'
import { commandTargetSessionIdForState } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import type { WorkspaceState } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'

/**
 * Resolves the composer that may receive a prompt template.
 *
 * WHY this is narrower than the shared command target: terminal panes are real
 * sessions and therefore valid targets for lifecycle commands, but they do not
 * own the agent composer that template insertion edits. Keeping this predicate
 * feature-owned and shared by both command visibility and execution prevents a
 * picker from advertising an action that can only return silently.
 */
export function promptTemplateTargetSessionId(workspace: Workspace): string | null {
  return promptTemplateTargetSessionIdForState(workspace.state)
}

export function promptTemplateTargetSessionIdForState(state: WorkspaceState): string | null {
  const sessionId = commandTargetSessionIdForState(state)
  if (!sessionId) return null
  const kind = state.sessions[sessionId]?.kind ?? DEFAULT_PROVIDER
  return kind === 'terminal' ? null : sessionId
}
