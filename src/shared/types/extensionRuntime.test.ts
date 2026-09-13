import { describe, expect, it } from 'vitest'
import { isExtensionJson, runtimeApiRequestSchema, runtimeEventSchema, runtimeHostRequestSchema } from './extensionRuntime'

describe('bounded extension runtime transport', () => {
  it('accepts nested JSON and shared references without changing values', () => {
    const shared = { count: 1, values: [true, null, 'hello'] }
    expect(isExtensionJson({ first: shared, second: shared })).toBe(true)
  })

  it('rejects deep, broad, oversized and cyclic payloads without recursive parsing', () => {
    let deep: unknown = null
    for (let index = 0; index < 34; index++) deep = [deep]
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    for (const value of [deep, new Array(4097).fill(null), 'x'.repeat(128 * 1024 + 1), cycle]) {
      expect(isExtensionJson(value)).toBe(false)
    }
  })

  it('rejects non-JSON values that would silently change during serialization', () => {
    for (const value of [NaN, Infinity, undefined, 1n, new Date(), new Map(), { value: () => {} }]) {
      expect(isExtensionJson(value)).toBe(false)
    }
  })

  it('cannot address another extension or invoke a generic host capability', () => {
    expect(runtimeApiRequestSchema.safeParse({ method: 'storage.get', key: 'saved', extensionId: 'other' }).success).toBe(false)
    expect(runtimeApiRequestSchema.safeParse({ method: 'invoke', channel: 'session:spawn' }).success).toBe(false)
    expect(runtimeApiRequestSchema.safeParse({ method: 'storage.set', key: '__proto__', value: {} }).success).toBe(false)
    expect(runtimeEventSchema.safeParse({ kind: 'result', id: 'call', ok: true, value: NaN }).success).toBe(false)
  })

  it('admits only bounded, versioned scoped filesystem shapes on both transports', () => {
    const request = { method: 'fs.readText', sessionId: 'session-one', path: 'src/index.ts' }
    const write = {
      method: 'fs.writeText', sessionId: 'session-one', path: 'src/index.ts',
      text: 'updated', expectedVersion: 'opaque-version',
    }
    expect(runtimeApiRequestSchema.parse(request)).toEqual(request)
    expect(runtimeApiRequestSchema.parse(write)).toEqual(write)
    expect(runtimeHostRequestSchema.safeParse({
      method: 'service', extensionId: 'timer', revision: 'generation-one', request,
    }).success).toBe(true)
    expect(runtimeHostRequestSchema.safeParse({
      method: 'service', extensionId: 'timer', revision: 'generation-one', request: write,
    }).success).toBe(true)
    expect(runtimeApiRequestSchema.safeParse({
      method: 'notifications.show', message: 'Focus session complete',
    }).success).toBe(true)
    for (const invalid of [
      { ...request, root: '/private/project' },
      { ...request, sessionId: '' },
      { ...request, path: '' },
      { ...request, path: 'x'.repeat(1025) },
      { method: 'fs.readFile', sessionId: 'session-one', path: 'src/index.ts' },
      { ...write, expectedVersion: undefined },
      { ...write, expectedVersion: '' },
      { ...write, text: 'x'.repeat(64 * 1024 + 1) },
      { ...write, root: '/private/project' },
      { method: 'notifications.show', message: '   ' },
      { method: 'notifications.show', message: 'x'.repeat(201) },
    ]) {
      expect(runtimeApiRequestSchema.safeParse(invalid).success).toBe(false)
    }
  })
})
