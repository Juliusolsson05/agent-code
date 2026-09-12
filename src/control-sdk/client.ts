import type { z } from 'zod'
import type { Capability } from './registration'
import type { ControlOwner, ControlResult, ControlTransport } from './contracts'

export function createControlClient(transport: ControlTransport) {
  return {
    // The capability carries inference at the call site. The transport never
    // receives its handler, only the stable ID, arguments, and optional owner.
    invoke<I extends z.ZodType, O extends z.ZodType>(
      capability: Capability<I, O>, input: z.input<I>, owner?: ControlOwner,
    ): Promise<ControlResult<z.output<O>>> {
      return transport.invoke({ capabilityId: capability.descriptor.id, input, owner }) as Promise<ControlResult<z.output<O>>>
    },
  }
}
