import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type { BuiltInMcpDomain, BuiltInMcpOverrides } from '@mcp/shared/types'
import { sessionMcpOverrides } from '@renderer/workspace/mcpDomains'
import { resumableProviderSessionId } from '@renderer/workspace/providerSessionIdentity'
import type { SessionId } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'

type ReloadWorkspace = Pick<Workspace, 'state' | 'replaceSession' | 'showPaneToast'>

/**
 * Replace a session's provider process with the same conversation and a new set
 * of built-in MCP choices, then tell the pane what happened.
 *
 * WHY every capability command funnels through here: the MCP server list is
 * fixed when a provider process launches, so changing a capability is always a
 * reload, and each of those reloads has to get three separate things right —
 * pin the target, resume the RIGHT conversation, and record intent rather than
 * an effective list. Root Agent Code Management (#906) first needed one owner
 * because its two entry points (the revoke command and the confirmation dialog)
 * must produce byte-identical reloads: Dispatch focus can move while the user
 * reads the warning, and an unpinned reload would land the grant on a different
 * agent. The capability toggles then turned out to be seven more copies of the
 * same operation, each of which had to be trusted to repeat those three things.
 *
 * WHY a provisional provider session id refuses instead of resuming: an id
 * whose source is `proxy-header` was observed on the wire and may belong to a
 * sidecar or sub-agent request rather than this pane's conversation, which is
 * why `withoutProvisionalProviderSession` strips it on every wake and why
 * `reloadSessionAgent` declines on it. Passing it here would either fail to
 * start or resume the pane onto somebody else's transcript — and because
 * `tldrIdentityForReplacement` reads a matching resume id as "same
 * conversation", the pane's TLDR would be carried onto that stranger. Declining
 * costs the user one retry a second later; the alternative silently rehomes a
 * live conversation.
 */
export async function reloadSessionWithBuiltInMcpOverrides(
  workspace: ReloadWorkspace,
  sessionId: SessionId,
  overrides: BuiltInMcpOverrides,
  labels: { reloaded: string; failed: string },
): Promise<SessionId | undefined> {
  const meta = workspace.state.sessions[sessionId]
  const kind = meta?.kind ?? DEFAULT_PROVIDER
  if (!meta || !isAgentProviderKind(kind)) return undefined
  const resumeSessionId = resumableProviderSessionId(meta)
  // An agent with no id at all is a brand-new pane with no transcript to lose,
  // so it may still take the capability change and start fresh. An agent whose
  // only id is provisional has a conversation that this reload cannot safely
  // re-enter.
  if (meta.providerSessionId && !resumeSessionId) {
    workspace.showPaneToast(sessionId, 'Provider session id is not ready yet')
    return undefined
  }
  try {
    const newSessionId = await workspace.replaceSession(meta.cwd, {
      kind,
      targetSessionId: sessionId,
      resumeSessionId,
      builtInMcpOverrides: overrides,
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

/** Set one capability for this agent and reload. The choice is recorded as an
 * explicit override so a later global Settings change cannot reverse it, and
 * the pane's other choices are preserved rather than rewritten by this edit. */
export function reloadSessionWithBuiltInMcpChoice(
  workspace: ReloadWorkspace,
  sessionId: SessionId,
  domain: BuiltInMcpDomain,
  enabled: boolean,
  labels: { reloaded: string; failed: string },
): Promise<SessionId | undefined> {
  const meta = workspace.state.sessions[sessionId]
  if (!meta) return Promise.resolve(undefined)
  return reloadSessionWithBuiltInMcpOverrides(
    workspace,
    sessionId,
    { ...sessionMcpOverrides(meta), [domain]: enabled },
    labels,
  )
}
