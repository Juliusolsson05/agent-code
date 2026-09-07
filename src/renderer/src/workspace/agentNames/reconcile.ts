import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'

import type { SessionMeta, WorkspaceState } from '@renderer/workspace/types'

function isNameable(meta: Pick<SessionMeta, 'kind'>): boolean {
  return isAgentProviderKind(meta.kind ?? DEFAULT_PROVIDER)
}

/**
 * Claim a durable identity for every agent that does not have one yet.
 *
 * WHY the identity is simply the current sessionId: it is already unique in
 * this workspace and stable for as long as the pane is not replaced, and the
 * replacement paths carry it forward from there. Minting a fresh UUID would be
 * equivalent but would make a workspace file harder to read when debugging a
 * mis-addressed agent.
 *
 * WHY this runs after restoration rather than at creation: only here can we
 * tell "restored pane that already owns Apollo" from "brand new pane". The
 * create path cannot, because replaceSession spawns through it.
 */
export function claimMissingIdentities(state: WorkspaceState): WorkspaceState {
  let changed = false
  const sessions = { ...state.sessions }
  for (const [sessionId, meta] of Object.entries(state.sessions)) {
    if (!isNameable(meta) || meta.agentNameId) continue
    sessions[sessionId] = { ...meta, agentNameId: sessionId }
    changed = true
  }
  // Identity-preserving on a no-op: this runs on every workspace change, and
  // returning a fresh object each time would invalidate every downstream
  // memo in the workspace tree.
  return changed ? { ...state, sessions } : state
}

/**
 * Every identity whose name this window needs.
 *
 * WHY buried records are included: their SessionMeta lives outside
 * `state.sessions` and outlives it, and workspace.observe deliberately reports
 * them. A buried agent that resolved to no name would be re-addressed on
 * restore, which is exactly the silent re-targeting #816 forbids.
 */
export function agentNameIdentities(state: WorkspaceState): string[] {
  const identities = new Set<string>()
  for (const meta of Object.values(state.sessions)) {
    if (isNameable(meta) && meta.agentNameId) identities.add(meta.agentNameId)
  }
  for (const record of state.buried) {
    if (isNameable(record.sessionMeta) && record.sessionMeta.agentNameId) {
      identities.add(record.sessionMeta.agentNameId)
    }
  }
  return [...identities]
}
