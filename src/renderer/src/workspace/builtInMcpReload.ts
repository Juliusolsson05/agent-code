import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type { BuiltInMcpDomain } from '@mcp/shared/types'
import { sessionMcpOverrides } from '@renderer/workspace/mcpDomains'
import type { SessionId } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'

type ReloadWorkspace = Pick<Workspace, 'state' | 'replaceSession' | 'showPaneToast'>

/**
 * Replace a session's provider process with the same conversation and a new
 * built-in MCP domain list, then tell the pane what happened.
 *
 * WHY this exists beside the inline copies in sessionCommands.ts: Root Agent
 * Code Management (#906) has two entry points that must produce byte-identical
 * reloads: the command (turning the capability OFF) and the confirmation
 * dialog's surface (turning it ON after the warning). One owner keeps the
 * target pinned in both, so Dispatch focus moving while the user reads the
 * warning cannot land the grant on a different agent. The MCP server list is
 * fixed at spawn time, which is why changing a domain is always a reload.
 */
export async function reloadSessionWithBuiltInMcpChoice(
  workspace: ReloadWorkspace,
  sessionId: SessionId,
  domain: BuiltInMcpDomain,
  enabled: boolean,
  labels: { reloaded: string; failed: string },
): Promise<SessionId | undefined> {
  const meta = workspace.state.sessions[sessionId]
  const kind = meta?.kind ?? DEFAULT_PROVIDER
  if (!meta || !isAgentProviderKind(kind)) return undefined
  try {
    const newSessionId = await workspace.replaceSession(meta.cwd, {
      kind,
      targetSessionId: sessionId,
      resumeSessionId: meta.providerSessionId,
      // An explicit per-agent CHOICE, not a new effective list: this grant is a
      // decision about this one agent, so a later global Settings change must
      // not silently reverse it (#904). root_management is never a Settings
      // default, so inheritance alone can never switch it on.
      builtInMcpOverrides: { ...sessionMcpOverrides(meta), [domain]: enabled },
    })
    if (newSessionId) workspace.showPaneToast(newSessionId, labels.reloaded)
    return newSessionId
  } catch (err) {
    workspace.showPaneToast(
      sessionId,
      err instanceof Error && err.message.length > 0 ? err.message : labels.failed,
    )
    return undefined
  }
}
