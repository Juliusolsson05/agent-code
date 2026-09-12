import {
  controlFailure, controlOwnerSchema,
  type CapabilityListing, type ControlContext, type ControlOwner, type ControlRequest, type ControlResult,
} from '../contracts'
import type { RegisteredCapability } from '../registration'

function ownerKey(owner: ControlOwner): string {
  return owner.kind === 'main' ? 'main' : `window:${owner.windowId}`
}

type Registration = { owner: ControlOwner; capabilities: Map<string, RegisteredCapability> }

// WHY this registry is private and dependency-injected: the app supplies feature
// handlers, not the other way around. There must never be an import from this
// directory to the workspace store or SessionManager. Main/window composition
// installs one batch per owner, making replacement and disposal atomic.
export function createControlRegistry() {
  const registrations = new Map<string, Registration>()

  return {
    register(ownerInput: ControlOwner, capabilities: readonly RegisteredCapability[]): () => void {
      const owner = Object.freeze(controlOwnerSchema.parse(ownerInput))
      const key = ownerKey(owner)
      if (registrations.has(key)) throw new Error(`Control owner already registered: ${key}`)
      const entries = new Map<string, RegisteredCapability>()
      for (const capability of capabilities) {
        const { id, execution } = capability.descriptor
        if (execution !== owner.kind) throw new Error(`${id} cannot execute in ${owner.kind}`)
        if (entries.has(id)) throw new Error(`Duplicate control capability: ${id}`)
        entries.set(id, capability)
      }
      const registration = { owner, capabilities: entries }
      registrations.set(key, registration)
      return () => {
        // A cleanup callback from the previous renderer world is allowed to run
        // late. It must not unregister the replacement that now owns the ID.
        if (registrations.get(key) === registration) registrations.delete(key)
      }
    },

    list(): CapabilityListing[] {
      return [...registrations.values()].flatMap(({ owner, capabilities }) =>
        [...capabilities.values()].map(({ descriptor }) => ({
          owner: { ...owner },
          descriptor: JSON.parse(JSON.stringify(descriptor)) as CapabilityListing['descriptor'],
        })),
      )
    },

    async invoke(request: ControlRequest, context: Omit<ControlContext, 'owner'>): Promise<ControlResult> {
      const candidates = [...registrations.values()].filter(registration =>
        registration.capabilities.has(request.capabilityId)
        && (!request.owner || ownerKey(registration.owner) === ownerKey(request.owner)),
      )
      if (!candidates.length) return controlFailure('unavailable', `No available owner for ${request.capabilityId}`)
      if (candidates.length !== 1) return controlFailure('ambiguous_owner', 'Choose an explicit owner from the catalog')
      const registration = candidates[0]
      if (request.owner && request.owner.generation !== registration.owner.generation) {
        return controlFailure('stale_owner', 'The owner reloaded; observe its current generation')
      }
      const capability = registration.capabilities.get(request.capabilityId)!
      const result = await capability.execute(request.input, Object.freeze({
        requestId: context.requestId, caller: Object.freeze({ ...context.caller }), owner: registration.owner,
      }))
      if (registrations.get(ownerKey(registration.owner)) !== registration) {
        // The handler might have finished just before its window closed. Do not
        // call it a known failure (or silently retry in a replacement window).
        return controlFailure('stale_owner', 'The owner changed during execution', 'unknown')
      }
      return result
    },
  }
}
