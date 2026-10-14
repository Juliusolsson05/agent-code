// The process's Hermes connection service, reachable from the provider
// runtime without threading it through every factory signature.
//
// WHY a set-once module slot (like the toolchain getters other provider
// runtimes import from @main/setup): MainProviderConfig.createSession takes
// only SessionOptions, and the registry is built before the service exists
// (main composition order, src/main/index.ts). A Hermes spawn before
// `setHermesConnectionService` ran is a composition bug and fails loudly.

import type { HermesConnectionService } from '@main/hermes/service.js'

let service: HermesConnectionService | null = null

export function setHermesConnectionService(next: HermesConnectionService): void {
  service = next
}

export function getHermesConnectionService(): HermesConnectionService {
  if (!service) throw new Error('Hermes connections are not initialised yet.')
  return service
}

export function peekHermesConnectionService(): HermesConnectionService | null {
  return service
}
