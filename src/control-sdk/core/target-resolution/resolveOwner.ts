import { ControlError, type CapabilityListing, type ControlRequest } from '../../contracts'

// The executor is the sole consumer of this arbitration. Protocol adapters may
// present candidates, but must not pick a window using focus or array order.
// A resolved owner is a snapshot, not a lock: registry dispatch checks its
// generation again, and feature handlers must revalidate entity IDs after I/O.
export function resolveOwner(request: ControlRequest, catalog: CapabilityListing[]): CapabilityListing {
  const candidates = catalog.filter(({ descriptor, owner }) => descriptor.id === request.capabilityId
    && (!request.owner || (owner.kind === request.owner.kind
      && (owner.kind === 'main' || (request.owner.kind === 'window' && owner.windowId === request.owner.windowId)))))
  if (!candidates.length) throw new ControlError('unavailable', `No owner for ${request.capabilityId}`)
  if (candidates.length !== 1) throw new ControlError('ambiguous_owner', 'Choose a window and generation from app.windows')
  const candidate = candidates[0]
  if (request.owner && request.owner.generation !== candidate.owner.generation) {
    throw new ControlError('stale_owner', 'Owner changed; observe again before acting')
  }
  return candidate
}
