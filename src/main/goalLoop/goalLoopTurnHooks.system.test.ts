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
afterEach(async () => {
  // A loop persists after every delivery, so a test that ends on
  // waitFor(deliver) can still have a temp file being renamed. Let it settle
  // before the directory goes (the #1028 re-review measured ENOTEMPTY in 4 of
  // 12 runs without this).
  await settle()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-code-goal-loop-hooks-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const store = new TldrStore(join(directory, 'tldr.json'))
  const goalStore = new TldrStore(join(directory, 'goal.json'), undefined, { historyDirectoryName: 'goal-history', label: 'Goal' })
  const deliver = vi.fn(async () => ({ ok: true } as PromptDeliveryResult))
  // The provider accepts input: this suite is about the hook boundary, not
  // about #1033's delivery-time readiness gate.
  // The provider's own readiness, which #1033's delivery gate consults. It
  // starts ready: every case except that one is about the hook boundary.
  const input = { ready: true, revision: 1 }
  const manager = Object.assign(new EventEmitter(), {
    deliverPromptToAgent: deliver,
    getBackendSnapshot: () => ({ input } as never),
  })
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
  return { host, loops, deliver, hook, report, input }
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

  it('never types into a turn that ANOTHER configured Stop hook kept going (#1033)', async () => {
    // Our hook allowing the stop says nothing about the user's own hooks:
    // Claude runs them all in parallel and Codex aggregates, so either keeps
    // the turn going when any of them blocks ("run the tests before
    // stopping"). We are told the turn ended, the turn has not ended, and the
    // continuation used to land mid-turn as a queued command — #1024's
    // symptom. The provider reports that as input that cannot take text.
    const { host, loops, deliver, hook, input } = await setup()
    const [config] = host.registerSession({ sessionId: 's-other-hook', cwd: '/project', providerKind: 'claude', domains: ['goal_loop'] })
    await loops.startLoop('s-other-hook', { goal: 'G.', loopPrompt: 'P.' })
    input.ready = false
    expect((await hook(config!, 'stop', { stop_hook_active: false })).status).toBe(200)
    await settle()
    expect(deliver).not.toHaveBeenCalled()

    // When that hook's work finishes, the turn really ends and the next Stop
    // delivers exactly once.
    input.ready = true
    await hook(config!, 'stop', { stop_hook_active: false })
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
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

  it('a subagent\'s hook (agent_id) never reopens the turn the main agent already stopped', async () => {
    // #1028 review, Probe B. Both CLIs send a subagent's hooks with the
    // parent's bearer, marked by `agent_id`. A background Task's tool call
    // after the main agent's Stop used to reopen the turn, so Resume found
    // it "open" and delivered nothing while the loop showed active.
    const { host, loops, deliver, hook } = await setup()
    const [config] = host.registerSession({ sessionId: 's3', cwd: '/project', providerKind: 'claude', domains: ['goal_loop'] })
    await loops.startLoop('s3', { goal: 'G.', loopPrompt: 'P.' })
    await hook(config!, 'post-tool-use', { session_id: 'claude-session' })
    loops.control('s3', { action: 'pause' })
    await hook(config!, 'stop', { session_id: 'claude-session', stop_hook_active: false })
    await hook(config!, 'post-tool-use', { session_id: 'claude-session', agent_id: 'background-reviewer', tool_name: 'Read' })
    loops.control('s3', { action: 'resume' })
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
  })

  it('a hook body the host cannot read never reopens the turn', async () => {
    // #1028 re-review: an unreadable body hides whether a subagent sent it,
    // so the agent_id rule failed open. Only a Stop is forwarded blind; a
    // blind non-Stop hook is dropped.
    const { host, loops, deliver, hook } = await setup()
    const [config] = host.registerSession({ sessionId: 's4', cwd: '/project', providerKind: 'claude', domains: ['goal_loop'] })
    await loops.startLoop('s4', { goal: 'G.', loopPrompt: 'P.' })
    await hook(config!, 'post-tool-use', { session_id: 'claude-session' })
    loops.control('s4', { action: 'pause' })
    await hook(config!, 'stop', { session_id: 'claude-session', stop_hook_active: false })
    const malformed = await fetch(`${config!.tldrHooks!.baseUrl}/post-tool-use`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${config!.bearerToken}` },
      body: '{"agent_id": "background-reviewer", "tool_response": ',
    })
    expect(malformed.status).toBe(200)
    loops.control('s4', { action: 'resume' })
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
  })
})
