import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { BuiltInMcpHttpHost } from '@mcp/runtime/BuiltInMcpHttpHost.js'
import type { PromptDeliveryResult } from '@shared/types/providerConfig.js'
import { TldrEnforcement } from '@main/tldr/enforcement.js'
import { TldrStore } from '@main/tldr/TldrStore.js'
import { GoalLoopService } from './GoalLoopService.js'
import { GoalLoopStore } from './GoalLoopStore.js'

vi.mock('@main/performance/PerformanceService.js', () => ({ performanceService: { record: vi.fn() } }))

// #1024 through the REAL MCP host: provider turn hooks arrive over real HTTP
// at /hooks/tldr/*, the real TLDR enforcement decides, and the real
// GoalLoopService takes its turn boundary from what the host forwards. Only
// the session manager (the process boundary that would type into an agent)
// is replaced.
//
// The regression this fences: a Claude goal loop delivered 37 continuations
// mid-turn, because the loop inferred "turn ended" from stream phases that go
// idle at every tool gap and flap on every subagent API flow. The provider's
// Stop hook is the boundary. These tests pin that it reaches the loop, that
// goal_loop sessions get it at all, and that a Stop TLDR blocks is not one.

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-code-goal-loop-hooks-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const store = new TldrStore(join(directory, 'tldr.json'))
  const goalStore = new TldrStore(join(directory, 'goal.json'), undefined, { historyDirectoryName: 'goal-history', label: 'Goal' })
  const deliver = vi.fn(async () => ({ ok: true } as PromptDeliveryResult))
  const manager = Object.assign(new EventEmitter(), { deliverPromptToAgent: deliver })
  const loops = new GoalLoopService({ manager, store: new GoalLoopStore(join(directory, 'goal-loop.json')) })
  await loops.start()
  const host = new BuiltInMcpHttpHost()
  host.setDependencies({ tldrStore: store, goalStore, tldrEnforcement: new TldrEnforcement(store, undefined, goalStore), goalLoopService: loops })
  await host.start()
  cleanups.push(() => host.stop())
  const hook = async (config: { tldrHooks?: { baseUrl: string }, bearerToken?: string }, event: string, body: unknown = {}) => {
    const response = await fetch(`${config.tldrHooks!.baseUrl}/${event}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${config.bearerToken}` },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }
  const report = async (config: { url: string, bearerToken?: string }, text: string) => {
    const client = new Client({ name: 'goal-loop-hook-test', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { Authorization: `Bearer ${config.bearerToken}` } } }))
    cleanups.push(() => client.close())
    await client.callTool({ name: 'tldr_update', arguments: { text } })
    await settle()
  }
  return { host, loops, deliver, hook, report }
}

describe('goal loop turn boundary through the real MCP host (#1024)', () => {
  it('installs turn hooks for a goal_loop-only registration', async () => {
    const { host } = await setup()
    const [config] = host.registerSession({ sessionId: 'loop-only', cwd: '/project', providerKind: 'claude', domains: ['goal_loop'] })
    // Before #1024, only tldr/goal registrations got hooks, so a loop-only
    // agent had no Stop signal and the loop fell back to stream phases.
    expect(config!.tldrHooks?.baseUrl).toMatch(/\/hooks\/tldr$/)
  })

  it('continues exactly once, on the Stop that ends the turn', async () => {
    const { host, loops, deliver, hook } = await setup()
    const [config] = host.registerSession({ sessionId: 's1', cwd: '/project', providerKind: 'claude', domains: ['goal_loop'] })
    await loops.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    // goal_loop_start's own PostToolUse arrives mid-turn; then the turn goes on.
    expect((await hook(config!, 'post-tool-use')).status).toBe(200)
    await settle()
    expect(deliver).not.toHaveBeenCalled()
    await hook(config!, 'stop', { stop_hook_active: false })
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
    await settle()
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('does not treat a Stop that TLDR enforcement blocked as a turn end', async () => {
    const { host, loops, deliver, hook, report } = await setup()
    const [config] = host.registerSession({ sessionId: 's2', tldrIdentity: 'summary-s2', cwd: '/project', providerKind: 'claude', domains: ['tldr', 'goal_loop'] })
    await loops.startLoop('s2', { goal: 'G.', loopPrompt: 'P.' })
    await hook(config!, 'post-tool-use')
    // No TLDR yet, so enforcement blocks this Stop and the model keeps working.
    const blocked = await hook(config!, 'stop', { stop_hook_active: false })
    expect(blocked.body).toMatchObject({ decision: 'block' })
    await settle()
    expect(deliver).not.toHaveBeenCalled()
    // The agent reports, and its next Stop is allowed. That one is the boundary.
    await report(config! as { url: string, bearerToken?: string }, 'Did the thing; next is the other thing.')
    const allowed = await hook(config!, 'stop', { stop_hook_active: true })
    expect(allowed.body).not.toMatchObject({ decision: 'block' })
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
  })
})
