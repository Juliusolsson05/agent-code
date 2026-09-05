import { z } from 'zod'
import { controlFailure, type CapabilityDescriptor, type ControlContext, type ControlResult } from './contracts'

export interface RegisteredCapability {
  readonly descriptor: CapabilityDescriptor
  execute(input: unknown, context: ControlContext): Promise<ControlResult>
}

export interface Capability<I extends z.ZodType, O extends z.ZodType> extends RegisteredCapability {
  readonly input: I
  readonly output: O
  execute(input: unknown, context: ControlContext): Promise<ControlResult<z.output<O>>>
}

// WHY schemas belong beside the handler: adding a control operation should be
// one feature edit, not coordinated copies of argument rules in IPC and MCP.
// The protocol adapter only sees serializable descriptors. It cannot inherit a
// React closure or acquire a domain singleton by enumerating the catalog.
export function defineCapability<I extends z.ZodType, O extends z.ZodType>(definition: {
  id: string
  title: string
  description: string
  execution: 'main' | 'window'
  effect: 'read' | 'ui' | 'mutation'
  completion?: 'completed' | 'accepted'
  input: I
  output: O
  handler(input: z.output<I>, context: ControlContext): z.input<O> | Promise<z.input<O>>
}): Capability<I, O> {
  if (!/^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/.test(definition.id)) {
    throw new Error(`Control capability needs a namespaced ID: ${definition.id}`)
  }
  const descriptor: CapabilityDescriptor = Object.freeze({
    id: definition.id,
    title: definition.title,
    description: definition.description,
    execution: definition.execution,
    effect: definition.effect,
    completion: definition.completion ?? 'completed',
    inputSchema: z.toJSONSchema(definition.input, { io: 'input' }),
    outputSchema: z.toJSONSchema(definition.output),
  })
  return Object.freeze({
    descriptor,
    input: definition.input,
    output: definition.output,
    async execute(raw: unknown, context: ControlContext): Promise<ControlResult<z.output<O>>> {
      const input = definition.input.safeParse(raw)
      if (!input.success) return controlFailure('invalid_input', input.error.message)
      try {
        const result = await definition.handler(input.data, context)
        const output = definition.output.safeParse(result)
        if (!output.success) return controlFailure('invalid_output', output.error.message, 'unknown')
        // WHY validate JSON even in the in-process path: a Date, undefined, or
        // class instance can appear to work in a local SDK trial then silently
        // change across IPC. Every successful result has identical wire shape.
        const json = z.json().safeParse(output.data)
        if (!json.success) return controlFailure('invalid_output', 'Capability returned a non-JSON value', 'unknown')
        return { ok: true, value: JSON.parse(JSON.stringify(json.data)) as z.output<O> }
      } catch (error) {
        // A thrown handler may already have performed its effect. Only failure
        // before dispatch is evidence that automatic resubmission is safe.
        return controlFailure('failed', error instanceof Error ? error.message : 'Capability failed', 'unknown')
      }
    },
  })
}
