import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentReadOutput, type AgentReadOutput } from '@control-sdk'
import { useAppStore } from '@renderer/app-state/store'
import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import type { AgentProviderKind } from '@shared/types/providerKind'
import { createLedgerInputAdapter } from '@renderer/rendering/adapter/collectLedgerInput'
import { createSessionLedger } from '@renderer/rendering/model/ledger'
import { ledgerToFeedItems } from '@renderer/features/feed/ledger/ledgerFeedItems'
import { providerLedgerFeedContextFromRuntime } from '@renderer/features/feed/ledger/providerLedgerFeedContext'
import { createAgentReadControl } from './control'
import { createConversationProjection } from './projectConversation'

const files = ['2026-05-20T19-11-51-193-d4a44a16', '2026-07-06T16-54-13-861-87f0eeef', '2026-07-07T13-17-48-452-5b19529f']
function fixture(file: string) {
  const { input } = JSON.parse(readFileSync(resolve('testing/fixtures/rendering-bundles', `${file}.json`), 'utf8'))
  const runtime: SessionRuntime = { ...emptyRuntime(), ...input,
    semantic: { ...emptyRuntime().semantic, currentTurn: input.semanticCurrent, history: input.semanticHistory },
    ghosts: new Map(Object.entries(input.ghosts)), sessionRunId: 'recorded-run' }
  return { runtime, provider: input.provider as AgentProviderKind }
}
const initial = useAppStore.getState()
const originalApi = window.api
const context = { requestId: 'read', caller: { kind: 'application' as const, id: 'test' }, owner: { kind: 'window' as const, windowId: 'test', generation: 'one' } }
const services: ReturnType<typeof createAgentReadControl>[] = []
afterEach(() => { services.splice(0).forEach(service => service.dispose()); useAppStore.setState(initial, true); vi.restoreAllMocks(); Object.defineProperty(window, 'api', { configurable: true, value: originalApi }) })
function setup(runtime: SessionRuntime, provider: AgentProviderKind, nativeId?: string) {
  useAppStore.setState({ workspaceState: { ...initial.workspaceState, sessions: { agent: { cwd: '/fixture', kind: provider, providerSessionId: nativeId } } }, workspaceRuntimes: { agent: runtime } })
  const service = createAgentReadControl(); services.push(service)
  const execute = async (input: Record<string, unknown> = {}): Promise<AgentReadOutput> => {
    const result = await service.capabilities[0].execute({ sessionId: 'agent', ...input }, context)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return agentReadOutput.parse(result.value)
  }
  return { execute, service }
}

describe('control reads from recorded provider bundles', () => {
  for (const file of files) it(`preserves all visible assistant blocks and default prose: ${file}`, () => {
    const { runtime, provider } = fixture(file)
    const projection = createConversationProjection()
    const messages = projection(runtime, provider, file, 'conversation')
    expect(messages.length).toBeGreaterThan(0)
    expect(new Set(messages.map(row => row.id)).size).toBe(messages.length)
    expect(messages.every(row => row.role !== 'activity')).toBe(true)
    // The oracle is the actual UI bridge, using the recorded input. This
    // checks our extraction boundary, not a second invented ownership model.
    const ledger = createSessionLedger()(createLedgerInputAdapter()({ provider, sessionId: file,
      entries: runtime.entries, semanticCurrent: runtime.semantic.currentTurn, semanticHistory: runtime.semantic.history,
      ghosts: runtime.ghosts, streamPhase: runtime.streamPhase, lastJsonlEntryAtMs: runtime.lastJsonlEntryAt }).input)
    const { items } = ledgerToFeedItems(ledger, providerLedgerFeedContextFromRuntime(runtime, provider).context)
    for (const item of items) {
      if (item.type === 'semantic-text' && item.text) expect(messages.find(row => row.id === item.key)?.text).toBe(item.text)
      if (item.type === 'semantic-block' && item.block.kind === 'text' && item.block.text) {
        expect(messages.find(row => row.id === item.key)).toMatchObject({ text: item.block.text, role: 'assistant' })
      }
    }
    expect(projection(runtime, provider, file, 'conversation')).toBe(messages)
    const full = projection(runtime, provider, file, 'full')
    for (const message of messages) expect(full.find(row => row.id === message.id)).toEqual(message)
  })

  it('pages a frozen recorded conversation losslessly and returns a cheap unchanged delta', async () => {
    const { runtime, provider } = fixture(files[0])
    const { execute } = setup(runtime, provider)
    const expected = createConversationProjection()(runtime, provider, 'agent', 'conversation')
    let page = await execute({ maxChars: 256, maxMessages: 2 })
    const rebuilt = new Map<string, string>()
    let count = 0
    while (true) {
      for (const row of page.messages) {
        expect(row.offset).toBe(rebuilt.get(row.id)?.length ?? 0)
        rebuilt.set(row.id, (rebuilt.get(row.id) ?? '') + row.text)
      }
      if (!page.nextCursor) break
      expect(++count).toBeLessThan(1000)
      page = await execute({ cursor: page.nextCursor, maxChars: 256, maxMessages: 2 })
    }
    expect([...rebuilt]).toEqual(expected.map(row => [row.id, row.text]))
    const delta = await execute({ range: 'delta', since: page.deltaCursor })
    expect(delta.messages).toEqual([])
    expect(delta.deletedMessageIds).toEqual([])
    useAppStore.setState({ workspaceRuntimes: { agent: { ...runtime, sessionRunId: 'replacement' } } })
    await expect(execute({ range: 'delta', since: delta.deltaCursor })).rejects.toThrow('stale_cursor')
  })

  it('status does no storage IO and a cold history failure never wakes or writes runtime', async () => {
    const runtime = emptyRuntime()
    const { execute } = setup(runtime, 'claude', 'native')
    const invoke = vi.fn().mockResolvedValue({ ok: false, error: { code: 'unavailable', message: 'File missing', outcome: 'not_started' } })
    Object.defineProperty(window, 'api', { configurable: true, value: { controlInvoke: invoke } })
    expect((await execute({ depth: 'status' })).messages).toEqual([])
    expect(invoke).not.toHaveBeenCalled()
    const page = await execute()
    expect(page).toMatchObject({ availability: 'unavailable', messages: [] })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().workspaceRuntimes.agent).toBe(runtime)
  })
})


it('reads an entire cold recorded transcript across archive snapshots and repeats a cursor without loss', async () => {
  const recorded = fixture(files[2])
  const runtime = emptyRuntime()
  const { execute } = setup(runtime, 'claude', 'native')
  const records = recorded.runtime.entries
  const invoke = vi.fn(async (request: { input: { cursor?: string } }) => {
    const end = request.input.cursor ? Number(request.input.cursor) : records.length
    const start = Math.max(0, end - 3)
    return { ok: true, value: { entries: records.slice(start, end), source: 'provider-file', sourceIdentity: 'recording', olderCursor: start ? String(start) : null } }
  })
  Object.defineProperty(window, 'api', { configurable: true, value: { controlInvoke: invoke } })
  const all = new Map<string, string>()
  let page = await execute({ maxChars: 262144, maxMessages: 200 })
  let archived = 0
  while (true) {
    for (const message of page.messages) {
      expect(all.has(message.id)).toBe(false)
      all.set(message.id, message.text)
    }
    expect(page.nextCursor).toBeNull()
    if (!page.olderCursor) break
    const cursor = page.olderCursor
    page = await execute({ older: cursor, maxChars: 262144, maxMessages: 200 })
    const calls = invoke.mock.calls.length
    const repeated = await execute({ older: cursor, maxChars: 262144, maxMessages: 200 })
    expect(repeated).toEqual(page)
    expect(invoke.mock.calls).toHaveLength(calls)
    expect(++archived).toBeLessThan(100)
  }
  expect(archived).toBeGreaterThan(16)
  const expected = createConversationProjection()({ ...runtime, entries: records }, 'claude', 'agent', 'conversation')
  expect([...all].sort()).toEqual(expected.map(row => [row.id, row.text]).sort())
  expect(useAppStore.getState().workspaceRuntimes.agent).toBe(runtime)
})
