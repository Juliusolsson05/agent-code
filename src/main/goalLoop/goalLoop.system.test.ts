import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createBuiltInMcpServer } from '@mcp/runtime/createBuiltInMcpServer.js'
import { GOAL_LOOP_INSTRUCTIONS } from '@shared/types/goalLoop.js'
import type { PromptDeliveryResult } from '@shared/types/providerConfig.js'
import { GoalLoopService } from './GoalLoopService.js'
import { GoalLoopStore } from './GoalLoopStore.js'

vi.mock('@main/performance/PerformanceService.js', () => ({ performanceService: { record: vi.fn() } }))

const directories: string[] = []
const clients: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })))
})

async function makeService() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-code-goal-loop-'))
  directories.push(directory)
  const manager = Object.assign(new EventEmitter(), { deliverPromptToAgent: vi.fn(async () => ({ ok: true } as PromptDeliveryResult)), getBackendSnapshot: () => ({ input: { ready: true, revision: 1 } } as never) })
  const service = new GoalLoopService({ manager, store: new GoalLoopStore(join(directory, 'goal-loop.json')) })
  await service.start()
  return { service, manager }
}

// `shared` lets two sessions talk to ONE service, which is production's shape
// (one GoalLoopService behind every session's MCP server) and the only shape
// in which session isolation can be observed at all.
async function setup(sessionId: string, shared?: Awaited<ReturnType<typeof makeService>>) {
  const { service, manager } = shared ?? await makeService()
  const server = createBuiltInMcpServer({ sessionId, cwd: '/project', domains: ['goal_loop'] }, { goalLoopService: service })
  const client = new Client({ name: 'goal-loop-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  clients.push(client, server)
  return { client, service, manager }
}

describe('Goal Loop MCP', () => {
  it('starts, continues on idle, and completes over the real tool surface', async () => {
    const { client, manager } = await setup('s1')
    const tools = (await client.listTools()).tools
    expect(tools.map(tool => tool.name).sort()).toEqual(['goal_loop_complete', 'goal_loop_start'])
    expect(client.getInstructions()).toContain(GOAL_LOOP_INSTRUCTIONS)
    const started = await client.callTool({ name: 'goal_loop_start', arguments: { goal: 'Migrate tests.', loopPrompt: 'Keep migrating.' } })
    expect(started.isError).not.toBe(true)
    manager.emit('semantic-event', { sessionId: 's1', event: { type: 'turn_completed' } })
    await vi.waitFor(() => expect(manager.deliverPromptToAgent).toHaveBeenCalledTimes(1))
    const completed = await client.callTool({ name: 'goal_loop_complete', arguments: { outcome: 'done', summary: 'Every test migrated and passing.' } })
    expect(completed.isError).not.toBe(true)
    manager.emit('semantic-event', { sessionId: 's1', event: { type: 'turn_completed' } })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(manager.deliverPromptToAgent).toHaveBeenCalledTimes(1)
  })
  it('cannot end or replace another session\'s loop through the tool surface', async () => {
    // The tools take no session id, so the only way to reach a loop is the
    // authenticated scope. s2 must be unable to touch s1's loop even though
    // both servers share the service that holds it.
    const shared = await makeService()
    const owner = await setup('s1', shared)
    const intruder = await setup('s2', shared)
    await owner.client.callTool({ name: 'goal_loop_start', arguments: { goal: 'Owner goal.', loopPrompt: 'Keep going.' } })
    const completed = await intruder.client.callTool({ name: 'goal_loop_complete', arguments: { outcome: 'done', summary: 'Not mine to end.' } })
    expect(completed.isError).toBe(true)
    await intruder.client.callTool({ name: 'goal_loop_start', arguments: { goal: 'Intruder goal.', loopPrompt: 'Mine.' } })
    expect(shared.service.snapshot()['s1']).toMatchObject({ phase: 'active', goal: 'Owner goal.' })
    expect(shared.service.snapshot()['s2']).toMatchObject({ phase: 'active', goal: 'Intruder goal.' })
  })
  it('rejects complete from a session with no loop and validates input', async () => {
    const { client } = await setup('s2')
    expect((await client.callTool({ name: 'goal_loop_complete', arguments: { outcome: 'done', summary: 'Nothing to complete.' } })).isError).toBe(true)
    expect((await client.callTool({ name: 'goal_loop_start', arguments: { goal: '', loopPrompt: 'P.' } })).isError).toBe(true)
    expect((await client.callTool({ name: 'goal_loop_start', arguments: { goal: 'G.', loopPrompt: 'P.', maxContinuations: 999 } })).isError).toBe(true)
  })
})
