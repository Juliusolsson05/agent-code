import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AgentNameRegistry } from '@main/agentNames/registry'

let directory: string
let path: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agent-names-'))
  // Deliberately one level deeper than the temp root: the registry must create
  // its own parent, because STATE_DIR does not exist on a first launch.
  path = join(directory, 'state', 'agent-names.json')
})

// Seed a pre-existing store the registry did not write, so the corrupt-store
// cases exercise the real read path rather than a mocked failure.
async function seedStore(contents: string): Promise<void> {
  await mkdir(join(directory, 'state'), { recursive: true })
  await writeFile(path, contents, 'utf8')
}

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function stored(): Promise<{ version: number; nextIndex: number; assignments: Record<string, string> }> {
  return JSON.parse(await readFile(path, 'utf8'))
}

describe('agent name registry', () => {
  it('commits an allocation to disk before returning it', async () => {
    const registry = new AgentNameRegistry(path)

    const names = await registry.resolve(['identity-a', 'identity-b'])

    expect(names).toEqual({ 'identity-a': 'Apollo', 'identity-b': 'Jasper' })
    // WHY the file is read straight after the await rather than after a tick:
    // "reserved before published" is the whole point. If resolve() can return a
    // name that is not yet durable, a crash between the two hands the same name
    // out twice on the next launch.
    expect(await stored()).toEqual({
      version: 1,
      nextIndex: 2,
      assignments: { 'identity-a': 'Apollo', 'identity-b': 'Jasper' },
    })
  })

  it('serializes concurrent window requests so two of them never share a name', async () => {
    // Two application windows are two renderers over ONE main process, so this
    // is the real concurrency shape: two in-flight resolve() calls on one
    // instance. Without the promise tail both read the same empty state and
    // both allocate index 0.
    const registry = new AgentNameRegistry(path)

    const [left, right] = await Promise.all([
      registry.resolve(['window-left']),
      registry.resolve(['window-right']),
    ])

    expect(left['window-left']).not.toBe(right['window-right'])
    expect(new Set([left['window-left'], right['window-right']])).toEqual(new Set(['Apollo', 'Jasper']))
    const file = await stored()
    expect(file.nextIndex).toBe(2)
    expect(Object.keys(file.assignments).sort()).toEqual(['window-left', 'window-right'])
  })

  it('reopens with the same assignments and never recycles a retired name', async () => {
    await new AgentNameRegistry(path).resolve(['kept', 'closed'])

    // A fresh instance is a fresh application launch over the same file.
    const reopened = new AgentNameRegistry(path)
    expect(await reopened.resolve(['kept'])).toEqual({ kept: 'Apollo' })
    // "closed" is gone from the workspace but its name stays spent: a delayed
    // voice request for Jasper must not land on a brand new agent.
    expect(await reopened.resolve(['fresh'])).toEqual({ fresh: 'Beatrix' })
    expect((await stored()).assignments).toEqual({ kept: 'Apollo', closed: 'Jasper', fresh: 'Beatrix' })
  })

  it('uses explicit numeric suffixes once the pool is exhausted', async () => {
    const registry = new AgentNameRegistry(path)
    const identities = Array.from({ length: 101 }, (_, index) => `s${index}`)

    const names = await registry.resolve(identities)

    expect(names.s99).toBe('Kai')
    expect(names.s100).toBe('Apollo 2')
    expect(new Set(Object.values(names)).size).toBe(101)
  })

  it('refuses to overwrite an unreadable store', async () => {
    await seedStore('{ this is not json')
    const registry = new AgentNameRegistry(path)

    await expect(registry.resolve(['identity-a'])).rejects.toThrow(/unreadable/i)
    // The bytes must be exactly what was there. Rewriting a corrupt file is how
    // a user loses every spoken address they had learned.
    expect(await readFile(path, 'utf8')).toBe('{ this is not json')
    // And it must keep refusing rather than "recovering" into an empty store.
    await expect(registry.resolve(['identity-a'])).rejects.toThrow(/unreadable/i)
  })

  it('refuses a store that already contains two identities under one name', async () => {
    await seedStore(JSON.stringify({
      version: 1,
      nextIndex: 2,
      assignments: { first: 'Apollo', second: 'apollo' },
    }))

    await expect(new AgentNameRegistry(path).resolve(['third'])).rejects.toThrow(/unreadable/i)
  })

  it('cannot pollute Object.prototype through a hostile identity', async () => {
    const registry = new AgentNameRegistry(path)

    const names = await registry.resolve(['__proto__'])

    expect(Object.getOwnPropertyDescriptor(names, '__proto__')?.value).toBe('Apollo')
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
    expect(Object.keys((await stored()).assignments)).toEqual(['__proto__'])
  })

  it('keeps a "__proto__" assignment across a reopen instead of re-allocating it', async () => {
    // WHY this case earns its own test: `z.record()` DROPS a "__proto__" key.
    // Verified against the pinned zod (^4.4.3):
    //
    //   JSON.parse own keys : ['__proto__', 'normal']
    //   z.record output keys: ['normal']
    //
    // A registry that trusted zod's OUTPUT as its data would silently forget
    // this assignment on the next launch and hand that agent a second name —
    // exactly the recycling this module exists to prevent, reachable from a
    // workspace file the user can edit. The schema stays the shape gate; the
    // raw parsed object is the data.
    await new AgentNameRegistry(path).resolve(['__proto__', 'normal'])
    const before = await stored()

    const reopened = new AgentNameRegistry(path)
    const again = await reopened.resolve(['__proto__', 'normal'])

    expect(Object.getOwnPropertyDescriptor(again, '__proto__')?.value).toBe('Apollo')
    expect(again.normal).toBe('Jasper')
    // Nothing was re-allocated: the counter did not move and the file is
    // unchanged, because resolve() found both assignments already present.
    expect(await stored()).toEqual(before)
    // And the next new identity continues the ranking rather than reusing one.
    expect((await reopened.resolve(['third'])).third).toBe('Beatrix')
  })

  it('refuses a "__proto__" assignment whose value the schema never validated', async () => {
    // The other half of the zod blind spot. Because z.record() skips this key,
    // `z.string().trim().min(1).max(100)` never runs for it, and all of these
    // parse clean against the schema (measured, zod 4.4.3).
    //
    // The empty string is the dangerous one: unlike a number it throws
    // nothing, so it would be adopted, count as "already assigned" in
    // allocate(), and leave that identity permanently unnameable — recorded
    // as having a name while every surface renders nothing.
    //
    // Written as raw JSON text on purpose: an object literal `{ __proto__: '' }`
    // sets the prototype and creates NO own property, so building this fixture
    // the obvious way would silently test nothing.
    for (const value of ['123', '""', `"${'x'.repeat(140)}"`]) {
      await seedStore(`{"version":1,"nextIndex":1,"assignments":{"__proto__":${value},"ok":"Apollo"}}`)
      await expect(new AgentNameRegistry(path).resolve(['ok'])).rejects.toThrow(/unreadable/i)
    }
  })
})
