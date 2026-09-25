import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createBuiltInMcpServer } from '@mcp/runtime/createBuiltInMcpServer.js'
import { BuiltInMcpHttpHost } from '@mcp/runtime/BuiltInMcpHttpHost.js'
import type { BuiltInMcpDomain } from '@mcp/shared/types.js'
import { GOAL_INSTRUCTIONS, TLDR_INSTRUCTIONS } from '@shared/types/tldr.js'
import { TldrStore } from './TldrStore.js'

vi.mock('@main/performance/PerformanceService.js', () => ({ performanceService: { record: vi.fn() } }))

const directories: string[] = []
const clients: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function setup(domains: BuiltInMcpDomain[] = ['tldr']) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-code-tldr-'))
  directories.push(directory)
  const file = join(directory, 'tldr.json')
  const store = new TldrStore(file)
  let active = true
  const server = createBuiltInMcpServer({ sessionId: 'routing-1', tldrIdentity: 'agent-1', cwd: '/project', domains }, {
    tldrStore: store, isTldrWriteAuthorized: () => active,
  })
  const client = new Client({ name: 'tldr-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  clients.push(client, server)
  return { client, store, file, revoke: () => { active = false } }
}

describe('TLDR MCP and durable summaries', () => {
  it('uses real HTTP bearer scopes for two agents and rejects the old token after replacement', async () => {
    const { store, file } = await setup()
    const host = new BuiltInMcpHttpHost()
    let entered!: () => void
    let continueWrite!: () => void
    const pendingEntered = new Promise<void>(resolve => { entered = resolve })
    const pendingWrite = new Promise<void>(resolve => { continueWrite = resolve })
    // Hold one real HTTP request between initial token authorization and its
    // durable write. Rejecting only NEW requests after revocation would pass
    // a simple 401 test while letting this old process overwrite its successor.
    host.setDependencies({ tldrStore: { update: async (...args: Parameters<TldrStore['update']>) => {
      if (args[1] === 'Delayed old report.') { entered(); await pendingWrite }
      return store.update(...args)
    } } })
    await host.start()
    const connect = async (sessionId: string, tldrIdentity: string) => {
      const [config] = host.registerSession({ sessionId, tldrIdentity, cwd: '/project', providerKind: 'codex', domains: ['tldr'] })
      const client = new Client({ name: 'http-tldr-test', version: '1' })
      await client.connect(new StreamableHTTPClientTransport(new URL(config!.url), {
        requestInit: { headers: { Authorization: `Bearer ${config!.bearerToken}` } },
      }))
      clients.push(client)
      return client
    }
    try {
      const first = await connect('process-a', 'logical-a')
      const second = await connect('process-b', 'logical-b')
      await first.callTool({ name: 'tldr_update', arguments: { text: 'A needs your decision.', identity: 'logical-b' } })
      await second.callTool({ name: 'tldr_update', arguments: { text: 'B is testing.' } })
      const staleResult = first.callTool({ name: 'tldr_update', arguments: { text: 'Delayed old report.' } })
      await pendingEntered
      host.revokeSession('process-a')
      const replacement = await connect('process-a-new', 'logical-a')
      await replacement.callTool({ name: 'tldr_update', arguments: { text: 'A is complete.' } })
      continueWrite()
      expect((await staleResult).isError).toBe(true)
      await expect(first.callTool({ name: 'tldr_update', arguments: { text: 'Stale old process.' } })).rejects.toThrow()
      const restored = await new TldrStore(file).read(['logical-a', 'logical-b', 'process-a-new'])
      expect(restored['logical-a']).toMatchObject({ text: 'A is complete.', revision: 2 })
      expect(restored['logical-b']).toMatchObject({ text: 'B is testing.', revision: 1 })
      expect(restored['process-a-new']).toBeUndefined()
    } finally {
      continueWrite()
      await host.stop()
    }
  })

  it('advertises no reporting tool or instructions when disabled', async () => {
    const { client, store } = await setup([])
    await expect(client.callTool({ name: 'tldr_update', arguments: { text: 'Must not be saved.' } })).rejects.toMatchObject({ code: -32601 })
    expect(client.getInstructions()).toBeUndefined()
    expect(await store.read(['agent-1'])).toEqual({})
  })

  it('replaces only the authenticated agent entry and restores it after restart', async () => {
    const { client, store, file } = await setup()
    const tools = (await client.listTools()).tools
    expect(tools.map(tool => tool.name)).toEqual(['tldr_update'])
    expect(tools[0]!.inputSchema.properties).not.toHaveProperty('sessionId')
    const changed = vi.fn()
    store.on('changed', changed)
    await client.callTool({ name: 'tldr_update', arguments: { text: 'Tests pass. Reviewing the PR.', sessionId: 'victim' } })
    const result = await client.callTool({ name: 'tldr_update', arguments: { text: '  PR #123 is merged.\nWork is complete. ' } })
    expect(result.isError).not.toBe(true)
    const snapshot = await new TldrStore(file).read(['agent-1', 'victim'])
    expect(Object.keys(snapshot)).toEqual(['agent-1'])
    expect(snapshot['agent-1']).toMatchObject({ text: 'PR #123 is merged. Work is complete.', revision: 2 })
    expect(changed).toHaveBeenCalledTimes(2)
    expect(JSON.parse(await readFile(file, 'utf8')).records).toEqual(snapshot)
  })

  it('rejects empty/oversized reports and revoked callers without changing the last summary', async () => {
    const { client, store, revoke } = await setup()
    await client.callTool({ name: 'tldr_update', arguments: { text: 'Waiting for your API decision.' } })
    for (const text of ['   ', 'x'.repeat(401), 'unsafe\u0000text']) {
      expect((await client.callTool({ name: 'tldr_update', arguments: { text } })).isError).toBe(true)
    }
    revoke()
    expect((await client.callTool({ name: 'tldr_update', arguments: { text: 'A stale caller overwrites the result.' } })).isError).toBe(true)
    expect((await store.read(['agent-1']))['agent-1']?.revision).toBe(1)
  })

  it('rechecks authorization after staging the write', async () => {
    const { store } = await setup()
    let checks = 0
    await expect(store.update('agent-1', 'Must never be published.', () => ++checks === 1)).rejects.toThrow('no longer active')
    expect(await store.read(['agent-1'])).toEqual({})
  })

  it('treats object-property names as ordinary opaque identities after prior writes', async () => {
    const { store, file } = await setup()
    await store.update('agent-1', 'First agent.', () => true)
    await store.update('constructor', 'Second agent.', () => true)
    expect((await new TldrStore(file).read(['constructor'])).constructor).toMatchObject({ text: 'Second agent.', revision: 1 })
  })

  it('preserves malformed storage instead of resetting it on the next update', async () => {
    const { file } = await setup()
    await writeFile(file, '{broken')
    await expect(new TldrStore(file).update('agent-1', 'Done.', () => true)).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe('{broken')
  })
})

describe('Goal MCP', () => {
  async function goalSetup(domains: BuiltInMcpDomain[]) {
    const directory = await mkdtemp(join(tmpdir(), 'agent-code-goal-'))
    directories.push(directory)
    const tldr = new TldrStore(join(directory, 'tldr.json'))
    const goal = new TldrStore(join(directory, 'goal.json'), undefined, { historyDirectoryName: 'goal-history', label: 'Goal' })
    let active = true
    const server = createBuiltInMcpServer({ sessionId: 'routing-1', tldrIdentity: 'agent-1', cwd: '/project', domains }, {
      tldrStore: tldr, goalStore: goal, isTldrWriteAuthorized: () => active,
    })
    const client = new Client({ name: 'goal-test', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    clients.push(client, server)
    return { client, tldr, goal, directory, revoke: () => { active = false } }
  }

  it('writes only the authenticated agent’s goal, kept apart from its TLDR and TLDR history', async () => {
    const { client, tldr, goal, directory } = await goalSetup(['tldr', 'goal'])
    const tools = (await client.listTools()).tools
    expect(tools.map(tool => tool.name).sort()).toEqual(['goal_complete', 'goal_set', 'tldr_update'])
    expect(tools.find(tool => tool.name === 'goal_set')!.inputSchema.properties).toEqual({ text: expect.any(Object) })
    await client.callTool({ name: 'goal_set', arguments: { text: 'Make reloads lossless.', identity: 'victim' } })
    await client.callTool({ name: 'tldr_update', arguments: { text: 'Reading the reload path.' } })

    expect(await goal.read(['agent-1', 'victim'])).toEqual({ 'agent-1': expect.objectContaining({ text: 'Make reloads lossless.', revision: 1 }) })
    expect(await tldr.read(['agent-1'])).toEqual({ 'agent-1': expect.objectContaining({ text: 'Reading the reload path.', revision: 1 }) })
    expect((await goal.history('agent-1')).map(entry => entry.text)).toEqual(['Make reloads lossless.'])
    expect((await tldr.history('agent-1')).map(entry => entry.text)).toEqual(['Reading the reload path.'])
    expect((await readdir(directory)).sort()).toEqual(['goal-history', 'goal.json', 'tldr-history', 'tldr.json'])
  })

  it('names Goal in the errors an agent reads and refuses a revoked caller', async () => {
    const { client, goal, revoke } = await goalSetup(['goal'])
    const empty = await client.callTool({ name: 'goal_set', arguments: { text: '   ' } })
    expect(empty.isError).toBe(true)
    expect(JSON.stringify(empty.content)).toContain('Goal must contain')
    await client.callTool({ name: 'goal_set', arguments: { text: 'Ship Goal.' } })
    revoke()
    const stale = await client.callTool({ name: 'goal_set', arguments: { text: 'A stale goal.' } })
    expect(stale.isError).toBe(true)
    expect(JSON.stringify(stale.content)).toContain('This Goal session is no longer active.')
    expect((await goal.read(['agent-1']))['agent-1']).toMatchObject({ text: 'Ship Goal.', revision: 1 })
  })

  it('offers and teaches only the capabilities the scope carries', async () => {
    const goalOnly = await goalSetup(['goal'])
    expect((await goalOnly.client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['goal_complete', 'goal_set'])
    expect(goalOnly.client.getInstructions()).toContain(GOAL_INSTRUCTIONS)
    expect(goalOnly.client.getInstructions()).not.toContain(TLDR_INSTRUCTIONS)

    const tldrOnly = await goalSetup(['tldr'])
    expect((await tldrOnly.client.listTools()).tools.map(tool => tool.name)).toEqual(['tldr_update'])
    // With another tool registered the SDK answers an unknown tool with an
    // error result rather than a protocol rejection; either way nothing saves.
    expect((await tldrOnly.client.callTool({ name: 'goal_set', arguments: { text: 'Must not be saved.' } })).isError).toBe(true)
    expect(tldrOnly.client.getInstructions()).not.toContain(GOAL_INSTRUCTIONS)
    expect(await tldrOnly.goal.read(['agent-1'])).toEqual({})
  })

  // #1182. The user closes agents from this record, so the contract under test
  // is: completion needs a goal, sticks to that goal across a restart, and is
  // cleared only by the agent setting a NEW goal.
  it('completes the caller’s own goal, keeps it across a restart, and clears it on the next goal_set', async () => {
    const { client, goal, directory } = await goalSetup(['goal'])
    const early = await client.callTool({ name: 'goal_complete', arguments: { summary: 'Nothing to complete yet.' } })
    expect(early.isError).toBe(true)
    expect(JSON.stringify(early.content)).toContain('Set a goal with goal_set before completing it.')
    expect(await goal.read(['agent-1'])).toEqual({})

    await client.callTool({ name: 'goal_set', arguments: { text: 'Ship goal completion.' } })
    const done = await client.callTool({ name: 'goal_complete', arguments: { summary: 'PR merged into main.', identity: 'victim' } })
    expect(done.isError).toBeFalsy()
    const completed = (await goal.read(['agent-1', 'victim']))
    // The goal text and its "set" time are untouched; only the completion pair
    // and the revision move, and nothing leaked to a model-supplied identity.
    expect(completed).toEqual({ 'agent-1': {
      text: 'Ship goal completion.', updatedAt: expect.any(String), revision: 2,
      completedAt: expect.any(String), completionNote: 'PR merged into main.',
    } })

    // A second process reading the same files: the pair is durable.
    const reopened = new TldrStore(join(directory, 'goal.json'), undefined, { historyDirectoryName: 'goal-history', label: 'Goal' })
    expect((await reopened.read(['agent-1']))['agent-1']).toMatchObject({ completionNote: 'PR merged into main.', revision: 2 })
    expect((await reopened.history('agent-1')).map(entry => [entry.text, entry.completed ?? false])).toEqual([
      ['PR merged into main.', true],
      ['Ship goal completion.', false],
    ])

    // Re-setting the SAME goal after completing it reopens the work: the
    // completion is gone and the history records the transition.
    await client.callTool({ name: 'goal_set', arguments: { text: 'Ship goal completion.' } })
    const reset = (await goal.read(['agent-1']))['agent-1']!
    expect(reset).toMatchObject({ text: 'Ship goal completion.', revision: 3 })
    expect(reset).not.toHaveProperty('completedAt')
    expect(reset).not.toHaveProperty('completionNote')
    expect((await goal.history('agent-1')).map(entry => entry.completed ?? false)).toEqual([false, true, false])
  })

  it('refuses a revoked caller’s completion after the store I/O', async () => {
    const { client, goal, revoke } = await goalSetup(['goal'])
    await client.callTool({ name: 'goal_set', arguments: { text: 'Ship Goal.' } })
    revoke()
    const stale = await client.callTool({ name: 'goal_complete', arguments: { summary: 'Done.' } })
    expect(stale.isError).toBe(true)
    expect(JSON.stringify(stale.content)).toContain('This Goal session is no longer active.')
    expect((await goal.read(['agent-1']))['agent-1']).not.toHaveProperty('completedAt')
  })

  it('loads pre-completion records unchanged and preserves a half-written completion instead of guessing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-code-goal-'))
    directories.push(directory)
    const file = join(directory, 'goal.json')
    const legacy = { version: 1, records: { 'agent-1': { text: 'Old goal.', updatedAt: '2026-09-01T00:00:00.000Z', revision: 4 } } }
    await writeFile(file, JSON.stringify(legacy))
    expect(await new TldrStore(file).read(['agent-1'])).toEqual(legacy.records)

    const broken = JSON.stringify({ version: 1, records: { 'agent-1': { ...legacy.records['agent-1'], completedAt: '2026-09-02T00:00:00.000Z' } } })
    await writeFile(file, broken)
    // Not guessed into a goal-without-completion: the record is set aside
    // (#1247), its bytes preserved, and the file itself is not rewritten by a
    // read.
    expect(await new TldrStore(file).read(['agent-1'])).toEqual({})
    expect(await readFile(file, 'utf8')).toBe(broken)
    const preserved = (await readdir(directory)).filter(name => name.startsWith('goal.json.invalid-'))
    expect(preserved).toHaveLength(1)
    expect(await readFile(join(directory, preserved[0]!), 'utf8')).toBe(broken)
  })

  // Review of #1182: behaviours only a direct store test can pin.
  it('stores the note normalized, leaves the goal’s set time alone, and announces the completion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-code-goal-'))
    directories.push(directory)
    const file = join(directory, 'goal.json')
    const goal = new TldrStore(file, undefined, { historyDirectoryName: 'goal-history', label: 'Goal' })
    const set = await goal.update('agent-1', 'Ship it.', () => true)
    const events: unknown[] = []
    goal.on('changed', update => events.push(update))

    // An unnormalized note would fail validCompletion on the NEXT load and make
    // the whole goal file unreadable for every agent.
    const done = await goal.complete('agent-1', '  PR   merged.\n', () => true)
    expect(done).toMatchObject({ completionNote: 'PR merged.', updatedAt: set.updatedAt, revision: 2 })
    expect(await new TldrStore(file).read(['agent-1'])).toEqual({ 'agent-1': done })
    // Every live reader (peek, close menu, history, phone) depends on this event.
    expect(events).toEqual([{ identity: 'agent-1', record: done }])
    expect(await goal.completedAt('agent-1')).toBe(done.completedAt)
  })

  it('records a completion whose note repeats the goal’s words as its own history row', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-code-goal-'))
    directories.push(directory)
    const goal = new TldrStore(join(directory, 'goal.json'), undefined, { historyDirectoryName: 'goal-history', label: 'Goal' })
    await goal.update('agent-1', 'Ship it.', () => true)
    await goal.complete('agent-1', 'Ship it.', () => true)
    await goal.update('agent-1', 'Ship it.', () => true)
    expect((await goal.history('agent-1')).map(entry => entry.completed ?? false)).toEqual([false, true, false])
  })

  it('treats a malformed completion marker in history as damage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-code-goal-'))
    directories.push(directory)
    const goal = new TldrStore(join(directory, 'goal.json'), undefined, { historyDirectoryName: 'goal-history', label: 'Goal' })
    await goal.update('agent-1', 'Ship it.', () => true)
    const historyDirectory = join(directory, 'goal-history')
    const [name] = await readdir(historyDirectory)
    const path = join(historyDirectory, name!)
    const document = JSON.parse(await readFile(path, 'utf8'))
    document.entries[0].completed = 'yes'
    await writeFile(path, JSON.stringify(document))
    await expect(goal.history('agent-1')).rejects.toThrow('history is invalid')
  })
})


// #1247: one invalid record used to make the whole store refuse, so every
// agent's tldr_update and goal_set failed, the peeks and Agent Activity went
// empty and the enforcement hooks threw. Real records from the owner's files
// (testing/fixtures/tldr-store, texts redacted to same-length markers).
const realRecords = JSON.parse(await readFile(join(import.meta.dirname,
  '../../../testing/fixtures/tldr-store/real-records-2026-09-25.json'), 'utf8')) as {
  tldr: { version: 1; records: Record<string, { text: string }> }
  goal: { version: 1; records: Record<string, { text: string; completedAt?: string; completionNote?: string }> }
  atLimit: string
}

describe('one invalid record in a real store (#1247)', () => {
  async function storeWith(name: string, document: unknown, options?: ConstructorParameters<typeof TldrStore>[2]) {
    const directory = await mkdtemp(join(tmpdir(), 'agent-code-tldr-invalid-'))
    directories.push(directory)
    const file = join(directory, name)
    const source = JSON.stringify(document)
    await writeFile(file, source)
    return { directory, file, source, store: new TldrStore(file, undefined, options) }
  }

  it('sets aside an over-limit TLDR (a newer build, then a downgrade) and keeps every other agent working', async () => {
    const document = structuredClone(realRecords.tldr)
    // One character past today's limit, on the real record that sits AT it.
    document.records[realRecords.atLimit]!.text += '.'
    const { directory, file, source, store } = await storeWith('tldr.json', document)
    const others = Object.keys(document.records).filter(id => id !== realRecords.atLimit)

    expect(Object.keys(await store.read(Object.keys(document.records))).sort()).toEqual([...others].sort())
    const written = await store.update(others[0]!, 'Still reporting.', () => true)
    expect(written.text).toBe('Still reporting.')
    // The set-aside record's bytes survive the rewrite that drops it.
    const preserved = (await readdir(directory)).filter(name => name.startsWith('tldr.json.invalid-'))
    expect(preserved).toHaveLength(1)
    expect(await readFile(join(directory, preserved[0]!), 'utf8')).toBe(source)
    expect(JSON.parse(await readFile(file, 'utf8')).records).not.toHaveProperty(realRecords.atLimit)
    // The damaged identity can simply report again.
    expect((await store.update(realRecords.atLimit, 'Back.', () => true)).text).toBe('Back.')
  })

  it('keeps the other goals and lets the damaged identity set a new goal when one completion is half-written', async () => {
    const document = structuredClone(realRecords.goal)
    const [completed, other] = Object.keys(document.records)
    delete document.records[completed!]!.completionNote
    const { store } = await storeWith('goal.json', document, { historyDirectoryName: 'goal-history', label: 'Goal' })
    expect(Object.keys(await store.read([completed!, other!]))).toEqual([other])
    expect((await store.update(completed!, 'A fresh goal.', () => true)).text).toBe('A fresh goal.')
  })

  it('does not write a second copy of the same damaged bytes on every launch', async () => {
    const document = structuredClone(realRecords.tldr)
    document.records[realRecords.atLimit]!.text += '.'
    const { directory, file } = await storeWith('tldr.json', document)
    await new TldrStore(file).read([realRecords.atLimit])
    await new TldrStore(file).read([realRecords.atLimit])
    expect((await readdir(directory)).filter(name => name.startsWith('tldr.json.invalid-'))).toHaveLength(1)
  })

  it('does not trust a partial copy left by a crash, and keeps the copy private', async () => {
    const document = structuredClone(realRecords.tldr)
    document.records[realRecords.atLimit]!.text += '.'
    const { directory, file, source } = await storeWith('tldr.json', document)
    // A crash mid-write left an empty file under the final digest name.
    const digest = createHash('sha256').update(source).digest('hex').slice(0, 16)
    await writeFile(join(directory, `tldr.json.invalid-${digest}.json`), '')
    const store = new TldrStore(file)
    const other = Object.keys(document.records).find(id => id !== realRecords.atLimit)!
    await store.update(other, 'Still here.', () => true)
    const copies = (await readdir(directory)).filter(name => name.startsWith('tldr.json.invalid-'))
    const contents = await Promise.all(copies.map(name => readFile(join(directory, name), 'utf8')))
    expect(contents).toContain(source)
    const full = copies[contents.indexOf(source)]!
    expect((await stat(join(directory, full))).mode & 0o777).toBe(0o600)
  })

  it('continues an identity above its set-aside revision, so readers do not discard it as stale', async () => {
    const document = structuredClone(realRecords.tldr) as { version: 1; records: Record<string, { text: string; revision: number }> }
    // A real record whose revision is well above 1 (#1257 review C1: the
    // at-limit record is revision 1, so "always continue at 2" also passed).
    const [identity, record] = Object.entries(document.records).sort(([, a], [, b]) => b.revision - a.revision)[0]!
    expect(record.revision).toBeGreaterThan(2)
    record.text = 'x'.repeat(401)
    const { store } = await storeWith('tldr.json', document)
    expect((await store.update(identity, 'Reporting again.', () => true)).revision).toBe(record.revision + 1)
  })

  // #1257 review C4: a set-aside record with a nonsense revision must not
  // seed a negative one on disk.
  it('does not continue from a set-aside revision below 1', async () => {
    const document = structuredClone(realRecords.tldr) as { version: 1; records: Record<string, { text: string; revision: number }> }
    const record = document.records[realRecords.atLimit]!
    record.text += '.'
    record.revision = -5
    const { store } = await storeWith('tldr.json', document)
    expect((await store.update(realRecords.atLimit, 'Reporting again.', () => true)).revision).toBe(1)
  })

  // #1257 review C2: re-posting an unchanged status after a salvage must
  // still repair the damaged file, or the history view keeps failing.
  it('repairs a damaged history when the agent re-posts an unchanged status', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-code-tldr-history-'))
    directories.push(directory)
    const store = new TldrStore(join(directory, 'tldr.json'))
    await store.update('agent-1', 'First.', () => true)
    await store.update('agent-1', 'Working.', () => true)
    const historyDirectory = join(directory, 'tldr-history')
    const [name] = (await readdir(historyDirectory)).filter(entry => entry.endsWith('.json'))
    const path = join(historyDirectory, name!)
    const history = JSON.parse(await readFile(path, 'utf8')) as { entries: Array<{ text: string; writtenAt: string; revision: number }> }
    history.entries.unshift({ text: 'x'.repeat(401), writtenAt: history.entries[0]!.writtenAt, revision: 99 })
    await writeFile(path, JSON.stringify(history))
    await expect(store.history('agent-1')).rejects.toThrow()
    await store.update('agent-1', 'Working.', () => true)
    expect((await store.history('agent-1')).map(entry => entry.text)).toEqual(['Working.', 'First.'])
  })

  // #1257 review C3: a damaged document that belongs to ANOTHER identity
  // must not donate its rows to this one.
  it('salvages nothing from a damaged history of a different identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-code-tldr-history-'))
    directories.push(directory)
    const store = new TldrStore(join(directory, 'tldr.json'))
    await store.update('agent-1', 'First.', () => true)
    const historyDirectory = join(directory, 'tldr-history')
    const [name] = (await readdir(historyDirectory)).filter(entry => entry.endsWith('.json'))
    const path = join(historyDirectory, name!)
    const writtenAt = new Date().toISOString()
    await writeFile(path, JSON.stringify({ version: 1, identity: 'agent-2', entries: [
      { text: 'x'.repeat(401), writtenAt, revision: 3 },
      { text: 'Another agent\'s status.', writtenAt, revision: 2 },
    ] }))
    await store.update('agent-1', 'Second.', () => true)
    expect((await store.history('agent-1')).map(entry => entry.text)).toEqual(['Second.'])
  })

  it('keeps the valid history entries and preserves the file when one entry is unreadable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-code-tldr-history-'))
    directories.push(directory)
    const file = join(directory, 'tldr.json')
    const store = new TldrStore(file)
    await store.update('agent-1', 'First.', () => true)
    await store.update('agent-1', 'Second.', () => true)
    const historyDirectory = join(directory, 'tldr-history')
    const [name] = (await readdir(historyDirectory)).filter(entry => entry.endsWith('.json'))
    const path = join(historyDirectory, name!)
    const history = JSON.parse(await readFile(path, 'utf8')) as { entries: Array<{ text: string }> }
    // A newer build's over-limit entry, on top of the older valid one.
    history.entries[0]!.text = 'x'.repeat(401)
    const raw = JSON.stringify(history)
    await writeFile(path, raw)

    await store.update('agent-1', 'Third.', () => true)
    expect((await store.history('agent-1')).map(entry => entry.text)).toEqual(['Third.', 'First.'])
    const preserved = (await readdir(historyDirectory)).filter(entry => entry.includes('.invalid-'))
    expect(preserved).toHaveLength(1)
    expect(await readFile(join(historyDirectory, preserved[0]!), 'utf8')).toBe(raw)
    // Evidence is not history: it must not count toward (or be evicted as) a history file.
    expect(preserved[0]!.endsWith('.json')).toBe(false)
  })

  it('keeps reads working when the copy cannot be written, and refuses writes until it can (review B)', async () => {
    const document = structuredClone(realRecords.tldr)
    document.records[realRecords.atLimit]!.text += '.'
    const { directory, file, source } = await storeWith('tldr.json', document)
    const others = Object.keys(document.records).filter(id => id !== realRecords.atLimit)
    await chmod(directory, 0o555)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const store = new TldrStore(file)
      expect(Object.keys(await store.read(others)).sort()).toEqual([...others].sort())
      await expect(store.update(others[0]!, 'Blocked.', () => true)).rejects.toThrow()
      expect(await readFile(file, 'utf8')).toBe(source)
      await chmod(directory, 0o755)
      await store.update(others[0]!, 'Now it can.', () => true)
      const copies = (await readdir(directory)).filter(name => name.startsWith('tldr.json.invalid-'))
      expect(await readFile(join(directory, copies[0]!), 'utf8')).toBe(source)
    } finally {
      warn.mockRestore()
      await chmod(directory, 0o755)
    }
  })

  it('sets aside a completion whose note is over the limit (a newer build, then a downgrade)', async () => {
    const document = structuredClone(realRecords.goal) as { version: 1; records: Record<string, { completionNote?: string }> }
    const [completed, other] = Object.keys(document.records)
    document.records[completed!]!.completionNote = 'x'.repeat(401)
    const { store } = await storeWith('goal.json', document, { historyDirectoryName: 'goal-history', label: 'Goal' })
    expect(Object.keys(await store.read([completed!, other!]))).toEqual([other])
  })

  it('never answers a read for an inherited property name', async () => {
    const { store } = await storeWith('tldr.json', structuredClone(realRecords.tldr))
    await store.update(realRecords.atLimit, 'Written.', () => true)
    expect(await store.read(['toString', 'constructor'])).toEqual({})
  })

  it('leaves an unreadable history file untouched rather than replacing it (round 2)', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-code-tldr-history-'))
    directories.push(directory)
    const store = new TldrStore(join(directory, 'tldr.json'))
    await store.update('agent-1', 'First.', () => true)
    await store.update('agent-1', 'Second.', () => true)
    const historyDirectory = join(directory, 'tldr-history')
    const [name] = (await readdir(historyDirectory)).filter(entry => entry.endsWith('.json'))
    const path = join(historyDirectory, name!)
    const before = await readFile(path, 'utf8')
    await chmod(path, 0o000)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // The report itself still succeeds; only its history row is skipped.
      expect((await store.update('agent-1', 'Third.', () => true)).text).toBe('Third.')
    } finally {
      warn.mockRestore()
      await chmod(path, 0o600)
    }
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('moves an oversized history aside without loading it (round 2)', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-code-tldr-history-'))
    directories.push(directory)
    const store = new TldrStore(join(directory, 'tldr.json'))
    await store.update('agent-1', 'First.', () => true)
    const historyDirectory = join(directory, 'tldr-history')
    const [name] = (await readdir(historyDirectory)).filter(entry => entry.endsWith('.json'))
    const oversized = 'x'.repeat(600 * 1024)
    await writeFile(join(historyDirectory, name!), oversized)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await store.update('agent-1', 'Second.', () => true)
    } finally {
      warn.mockRestore()
    }
    const aside = (await readdir(historyDirectory)).filter(entry => entry.includes('.invalid-oversize-'))
    expect(aside).toHaveLength(1)
    expect(await readFile(join(historyDirectory, aside[0]!), 'utf8')).toBe(oversized)
    expect((await store.history('agent-1')).map(entry => entry.text)).toEqual(['Second.'])
  })

  it('still refuses a malformed document container, which a write would destroy whole', async () => {
    const { file, source } = await storeWith('tldr.json', { version: 2, records: realRecords.tldr.records })
    await expect(new TldrStore(file).read([realRecords.atLimit])).rejects.toThrow('storage is invalid')
    expect(await readFile(file, 'utf8')).toBe(source)
  })
})
