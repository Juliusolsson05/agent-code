import { ControlError, type CapabilityListing, type ControlOwner, type ControlRequest } from '../../contracts'

export type OwnershipEvidence = (kind: 'session' | 'project', id: string) => Promise<ControlOwner[]>

// The executor is the sole consumer of this arbitration. Protocol adapters may
// present candidates, but must not pick a window using focus or array order.
// A resolved owner is a snapshot, not a lock: registry dispatch checks its
// generation again, and feature handlers must revalidate entity IDs after I/O.
export async function resolveOwner(request: ControlRequest, catalog: CapabilityListing[], evidence?: OwnershipEvidence): Promise<CapabilityListing> {
  let candidates = catalog.filter(({ descriptor, owner }) => descriptor.id === request.capabilityId
    && (!request.owner || (owner.kind === request.owner.kind
      && (owner.kind === 'main' || (request.owner.kind === 'window' && owner.windowId === request.owner.windowId)))))
  if (!candidates.length) throw new ControlError('unavailable', `No owner for ${request.capabilityId}`)
  if (!request.owner && candidates.every(candidate => candidate.descriptor.replicated === true
    && candidate.descriptor.effect === 'read' && !candidate.descriptor.target)) {
    // Authored app documentation is identical in every window and must work
    // as the first operator call. This opt-in never applies to live shortcuts,
    // focus, or mutations. Return the selected owner as normal for provenance.
    candidates = [...candidates].sort((a, b) => JSON.stringify(a.owner).localeCompare(JSON.stringify(b.owner))).slice(0, 1)
  }
  const target = candidates[0].descriptor.target
  if (!request.owner && target && evidence) {
    // All registrations of one capability must agree about target semantics.
    // A mixed-version window is not permission to choose whichever registers
    // first. Observe all owners; a failed observation must not mean "absent".
    if (candidates.some(candidate => JSON.stringify(candidate.descriptor.target) !== JSON.stringify(target))) {
      throw new ControlError('unavailable', 'Windows disagree about the target contract; reload before acting')
    }
    const id = request.input && typeof request.input === 'object' ? (request.input as Record<string, unknown>)[target.field] : undefined
    if (typeof id !== 'string' || !id) throw new ControlError('invalid_input', `Provide ${target.field}`)
    const owners = await evidence(target.kind, id)
    candidates = candidates.filter(candidate => owners.some(owner => owner.kind === candidate.owner.kind
      && owner.generation === candidate.owner.generation && (owner.kind === 'main'
        || (candidate.owner.kind === 'window' && owner.windowId === candidate.owner.windowId))))
    if (!candidates.length) throw new ControlError('unavailable', 'No available window owns that target')
  }
  if (candidates.length !== 1) throw new ControlError('ambiguous_owner', 'Choose a window and generation from app.windows')
  const candidate = candidates[0]
  if (request.owner && request.owner.generation !== candidate.owner.generation) {
    throw new ControlError('stale_owner', 'Owner changed; observe again before acting')
  }
  return candidate
}
