// Feature integration and callers use this explicit contract. Host construction
// is a separate entry point so importing a descriptor cannot start the router.
export { defineCapability } from './registration'
export type { Capability, RegisteredCapability } from './registration'
export { createControlClient } from './client'
export { controlOwnerSchema, controlFailure, ControlError } from './contracts'
export { paginate, pageSchema, pageInput } from './catalog/pagination'
export { featureReferenceSchema } from './catalog/features'
export type { FeatureReference } from './catalog/features'
export type { InteractionReference } from './catalog/interactions'
export { historyEventSchema } from './history'
export type { ControlHistory, HistoryEvent, HistoryWrite } from './history'
export {
  capabilityDescriptorSchema, controlRegistrationSchema, controlRequestSchema,
  controlResultSchema, rendererControlResponseSchema,
} from './contracts'
export type {
  CapabilityDescriptor, CapabilityListing, ControlCaller, ControlContext,
  ControlFailureCode, ControlOwner, ControlRequest, ControlResult, ControlTransport,
  ControlRegistration, RendererControlRequest, RendererControlResponse,
} from './contracts'
