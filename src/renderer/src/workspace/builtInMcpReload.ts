import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type { BuiltInMcpDomain } from '@mcp/shared/types'
import type { SessionId } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'

type ReloadWorkspace = Pick<Workspace, 'state' | 'replaceSession' | 'showPaneToast'>

/**
 * The session's complete domain list with `domain` added or removed.
 *
 * A session's `builtInMcpDomains` is a full snapshot, never an overlay (see
 * mcpDomains.ts), so callers must always write the whole list back. Order is
 * preserved and duplicates collapse so a repeated enable is a no-op reload.
 */
export function withBuiltInMcpDomain(
  domains: readonly BuiltInMcpDomain[] | undefined,
  domain: BuiltInMcpDomain,
  enabled: boolean,
): BuiltInMcpDomain[] {
  const current = domains ?? []
  return enabled
    ? Array.from(new Set([...current, domain]))
    : current.filter(existing => existing !== domain)
}

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
export async function reloadSessionWithBuiltInMcpDomains(
  workspace: ReloadWorkspace,
  sessionId: SessionId,
  domains: BuiltInMcpDomain[],
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
      builtInMcpDomains: domains,
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
