import { AGENT_NAME_IDENTITY_MAX_LENGTH } from '@shared/types/agentNames'
import { identityCarryIsPending } from '@renderer/workspace/agentNames/pendingIdentityCarry'
import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'

import type { SessionMeta, WorkspaceState } from '@renderer/workspace/types'

function isNameable(meta: Pick<SessionMeta, 'kind'>): boolean {
  return isAgentProviderKind(meta.kind ?? DEFAULT_PROVIDER)
}

/**
 * The usable identity on a session's metadata, or null.
 *
 * WHY the SHAPE is checked and not merely truthiness: `agentNameId` comes back
 * from a workspace file a user (or a future migration) can hand-edit, so it can
 * be a number, an object or an empty string. Both consumers demand a non-empty
 * string — `resolveAgentName` needs it as an own key of the name map, and the
 * IPC allocator validates `z.array(z.string().min(1).max(200))` — so a
 * malformed value has to read as ABSENT in both places or the two disagree:
 *
 *  - in `claimMissingIdentities`, a truthy non-string counted as "already
 *    identified" while the selector resolved it to null, so that agent stayed
 *    permanently unnamed with no way to heal short of editing the file again.
 *    Re-claiming it is safe; the only thing it can lose is a name that was
 *    never resolvable.
 *  - in `agentNameIdentities`, a non-string reached `resolveAgentNames` and the
 *    schema rejects the whole array, so ONE malformed buried record blocked
 *    naming for every agent in the window. Buried records never pass through
 *    the claim above (it walks `state.sessions` only), so that guard cannot
 *    cover this one.
 *
 * WHY the LENGTH bound is imported rather than written here: this comment
 * already named main's schema verbatim, but only the type half was actually
 * mirrored. An identity longer than 200 characters passed this check, entered
 * the request array, and made the whole batch fail validation — the exact
 * batch-wide outage the paragraph above describes, reachable from one
 * hand-edited workspace.json. Sharing the constant makes the two halves
 * impossible to drift apart again.
 */
function identityOf(meta: Pick<SessionMeta, 'agentNameId'>): string | null {
  const identity = meta.agentNameId
  if (typeof identity !== 'string') return null
  if (identity.length === 0 || identity.length > AGENT_NAME_IDENTITY_MAX_LENGTH) return null
  return identity
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
    if (!isNameable(meta) || identityOf(meta)) continue
    // A successor mid-replacement is about to inherit its predecessor's
    // identity in this same operation. Claiming one for it here allocates a
    // name that the very next commit overwrites and that nothing will ever
    // reference again — and names are never recycled. See
    // pendingIdentityCarry for why the gap is observable at all.
    if (identityCarryIsPending(sessionId)) continue
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
    const identity = isNameable(meta) ? identityOf(meta) : null
    if (identity) identities.add(identity)
  }
  for (const record of state.buried) {
    const identity = isNameable(record.sessionMeta) ? identityOf(record.sessionMeta) : null
    if (identity) identities.add(identity)
  }
  return [...identities]
}
