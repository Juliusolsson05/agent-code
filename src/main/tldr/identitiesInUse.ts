import { projectWorkspace } from '@main/agentActivity/workspaceProjection.js'
import type { PersistedWindow } from '@main/storage/workspaceFile.js'

/**
 * The TLDR/Goal identities the stores may never evict at their cap (#1277,
 * #1328 review).
 *
 * WHY both sources:
 * - The persisted workspace of EVERY window: a parked or hibernated agent has
 *   no backend, yet its pane, peek, Agent Activity row and Close Completed
 *   Agents row all read its TLDR and goal by this identity. Every renderer
 *   view reads identities of workspace sessions only, which is what makes
 *   "not in any workspace" a safe definition of "nobody is looking".
 * - Live MCP registrations: an agent spawned since the last autosave is not in
 *   the file yet but is running and can call goal_complete.
 *
 * `windows === null` means the workspace file has not opened yet: unknown, so
 * the caller evicts nothing (steering q40).
 */
export function tldrIdentitiesInUse(
  windows: readonly PersistedWindow[] | null,
  liveIdentities: Iterable<string>,
): ReadonlySet<string> | null {
  if (windows === null) return null
  const inUse = new Set(liveIdentities)
  for (const placement of projectWorkspace(windows).sessions.values()) {
    if (placement.tldrIdentity) inUse.add(placement.tldrIdentity)
    // WHY the session id as well, for every session (#1328 round 2, all
    // three reviewers): the renderer reads a session with no explicit
    // `tldrIdentity` under its SESSION ID when TLDR or Goal is enabled
    // (tldrIdentityForSession, for main-created and older agents), and the
    // peek, Agent Activity and Close Completed Agents all use that fallback.
    // Protecting every persisted session id is a superset of that rule, so
    // it cannot drift from it; the cost is a few extra ids never evicted.
    inUse.add(placement.sessionId)
  }
  return inUse
}
