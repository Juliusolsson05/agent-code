import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createControlClient, defineCapability, type ControlOwner } from '../index'
import { createControlRegistry } from '../host'

const owner: ControlOwner = { kind: 'window', windowId: 'window-a', generation: 'first-renderer' }
const context = { requestId: 'request-1', caller: { kind: 'external' as const, id: 'operator-1' } }

function navigation(handler = vi.fn(async ({ sessionId }: { sessionId: string }) => ({ shown: sessionId }))) {
  return defineCapability({
    id: 'agents.show', title: 'Show agent', description: 'Reveal an existing session',
    execution: 'window', effect: 'ui',
    input: z.object({ sessionId: z.string().min(1) }).strict(),
    output: z.object({ shown: z.string() }).strict(), handler,
  })
}

describe('control registration lifetime and dispatch contracts', () => {
  it('validates before effects and binds caller identity outside arguments', async () => {
    const handler = vi.fn(async ({ sessionId }: { sessionId: string }) => ({ shown: sessionId }))
    const capability = navigation(handler)
    const registry = createControlRegistry()
    registry.register(owner, [capability])
    const client = createControlClient({ invoke: request => registry.invoke(request, context) })
    const forged = await registry.invoke({ capabilityId: 'agents.show', input: { sessionId: 'a', caller: 'application' } }, context)
    expect(forged).toMatchObject({ ok: false, error: { code: 'invalid_input', outcome: 'not_started' } })
    expect(handler).not.toHaveBeenCalled()
    expect(await client.invoke(capability, { sessionId: 'a' }, owner)).toEqual({ ok: true, value: { shown: 'a' } })
    expect(handler).toHaveBeenCalledWith({ sessionId: 'a' }, { ...context, owner })
  })

  it('never chooses the first window when several expose the same capability', async () => {
    const handler = vi.fn(async ({ sessionId }: { sessionId: string }) => ({ shown: sessionId }))
    const registry = createControlRegistry()
    registry.register(owner, [navigation(handler)])
    registry.register({ ...owner, windowId: 'window-b' }, [navigation(handler)])
    expect(await registry.invoke({ capabilityId: 'agents.show', input: { sessionId: 'a' } }, context))
      .toMatchObject({ ok: false, error: { code: 'ambiguous_owner', outcome: 'not_started' } })
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects an entire duplicate batch and leaves the owner available to register correctly', () => {
    const registry = createControlRegistry()
    const capability = navigation()
    expect(() => registry.register(owner, [capability, capability])).toThrow('Duplicate')
    expect(registry.list()).toEqual([])
    const dispose = registry.register(owner, [capability])
    expect(() => registry.register(owner, [capability])).toThrow('already registered')
    dispose()
    registry.register({ ...owner, generation: 'second-renderer' }, [capability])
    dispose()
    expect(registry.list()[0].owner.generation).toBe('second-renderer')
  })

  it('rejects a stale route without dispatch and reports a replaced in-flight owner as uncertain', async () => {
    let finish!: (value: { shown: string }) => void
    const handler = vi.fn(() => new Promise<{ shown: string }>(resolve => { finish = resolve }))
    const registry = createControlRegistry()
    const dispose = registry.register(owner, [navigation(handler)])
    expect(await registry.invoke({ capabilityId: 'agents.show', input: { sessionId: 'a' }, owner: { ...owner, generation: 'old' } }, context))
      .toMatchObject({ ok: false, error: { code: 'stale_owner', outcome: 'not_started' } })
    expect(handler).not.toHaveBeenCalled()
    const pending = registry.invoke({ capabilityId: 'agents.show', input: { sessionId: 'a' }, owner }, context)
    dispose()
    registry.register({ ...owner, generation: 'new' }, [navigation()])
    finish({ shown: 'a' })
    expect(await pending).toMatchObject({ ok: false, error: { code: 'stale_owner', outcome: 'unknown' } })
  })

  it('does not misreport a handler failure after dispatch as safe to repeat', async () => {
    const registry = createControlRegistry()
    registry.register(owner, [navigation(vi.fn(async () => { throw new Error('Window closed after effect') }))])
    expect(await registry.invoke({ capabilityId: 'agents.show', input: { sessionId: 'a' }, owner }, context))
      .toMatchObject({ ok: false, error: { code: 'failed', outcome: 'unknown' } })
  })

  it('does not expose handlers or mutable registry metadata in catalog results', () => {
    const registry = createControlRegistry()
    registry.register(owner, [navigation()])
    const entry = registry.list()[0]
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry)
    entry.descriptor.inputSchema.properties = {}
    entry.owner.generation = 'forged'
    expect(registry.list()[0].descriptor.inputSchema.properties).toHaveProperty('sessionId')
    expect(registry.list()[0].owner.generation).toBe('first-renderer')
  })
})
