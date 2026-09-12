import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { BuiltInMcpHttpHost } from '@mcp/runtime/BuiltInMcpHttpHost.js'
import type { BuiltInMcpDomain } from '@mcp/shared/types.js'
import { TLDR_GOAL_CONTEXT, TLDR_NEVER_WRITTEN_REASON, TLDR_STALE_REASON, TldrEnforcement } from './enforcement.js'
import { TldrStore } from './TldrStore.js'

vi.mock('@main/performance/PerformanceService.js', () => ({ performanceService: { record: vi.fn() } }))

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

// Real timestamps come from two clocks (store and enforcement). A few
// milliseconds separate a report from the prompt that follows it, so ordering
// is decided by the rules under test rather than by a same-millisecond tie.
const settle = () => new Promise(resolve => setTimeout(resolve, 5))

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-code-tldr-hooks-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const store = new TldrStore(join(directory, 'tldr.json'))
  const host = new BuiltInMcpHttpHost()
  const enforcement = new TldrEnforcement(store)
  host.setDependencies({ tldrStore: store, tldrEnforcement: enforcement })
  await host.start()
  cleanups.push(() => host.stop())
  const register = (sessionId: string, domains: BuiltInMcpDomain[] = ['tldr'], tldrIdentity = `summary-${sessionId}`) =>
    host.registerSession({ sessionId, tldrIdentity, cwd: '/project', providerKind: 'codex', domains })[0]!
  const hook = async (config: { tldrHooks?: { baseUrl: string }; url: string }, token: string | undefined, event: string, body: unknown = {}) => {
    const base = config.tldrHooks?.baseUrl ?? new URL('/hooks/tldr', config.url).toString()
    const response = await fetch(`${base}/${event}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }
  const report = async (config: { url: string; bearerToken?: string }, text: string) => {
    const client = new Client({ name: 'tldr-hook-test', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: { Authorization: `Bearer ${config.bearerToken}` } },
    }))
    cleanups.push(() => client.close())
    await client.callTool({ name: 'tldr_update', arguments: { text } })
    await settle()
  }
  return { host, store, enforcement, register, hook, report }
}

describe('TLDR turn hooks through the real MCP host', () => {
  it('enforces a whole session lifecycle against the reports its own MCP tool writes', async () => {
    const { register, hook, report } = await setup()
    const agent = register('a')
    expect(agent.tldrHooks?.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hooks\/tldr$/)
    const token = agent.bearerToken

    expect((await hook(agent, token, 'user-prompt-submit')).body).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: TLDR_GOAL_CONTEXT },
    })
    expect((await hook(agent, token, 'stop')).body).toEqual({ decision: 'block', reason: TLDR_NEVER_WRITTEN_REASON })

    await report(agent, 'Goal: add history to TLDR. Reading the store first.')
    expect((await hook(agent, token, 'user-prompt-submit')).body).toEqual({})
    expect((await hook(agent, token, 'stop')).body).toEqual({})

    await hook(agent, token, 'user-prompt-submit')
    await hook(agent, token, 'post-tool-use', { tool_name: 'Edit' })
    expect((await hook(agent, token, 'stop')).body).toEqual({ decision: 'block', reason: TLDR_STALE_REASON })
    await report(agent, 'History is implemented and tests pass. Opening the PR next.')
    expect((await hook(agent, token, 'stop', { stop_hook_active: true })).body).toEqual({})
  })

  it('refuses missing and foreign credentials and stops a revoked process at once', async () => {
    const { host, register, hook, report } = await setup()
    const a = register('a')
    const b = register('b')
    await report(a, 'A is working.')
    await report(b, 'B is working.')

    expect((await hook(a, undefined, 'stop')).status).toBe(401)
    await hook(a, a.bearerToken, 'user-prompt-submit')
    await hook(a, a.bearerToken, 'post-tool-use')
    await hook(b, b.bearerToken, 'user-prompt-submit')
    // B's token addresses only B's turn: A's unreported tool work is invisible to it.
    expect((await hook(b, b.bearerToken, 'stop')).body).toEqual({})
    expect((await hook(a, a.bearerToken, 'stop')).body).toEqual({ decision: 'block', reason: TLDR_STALE_REASON })

    host.revokeSession('a')
    expect((await hook(a, a.bearerToken, 'stop')).status).toBe(401)
  })

  it('drops a revoked process’s hook contact so a silent replacement shows as inactive', async () => {
    const { host, enforcement, register, hook } = await setup()
    const original = register('process-a', ['tldr'], 'summary-kept')
    await hook(original, original.bearerToken, 'post-tool-use')
    expect(enforcement.status(['summary-kept'])['summary-kept']!.hookContactAt).toEqual(expect.any(String))
    // A reload revokes the old process and registers a replacement that keeps
    // the conversation's TLDR identity.
    host.revokeSession('process-a')
    const replacement = register('process-b', ['tldr'], 'summary-kept')
    expect(enforcement.status(['summary-kept'])).toEqual({ 'summary-kept': { hookContactAt: null } })
    await hook(replacement, replacement.bearerToken, 'user-prompt-submit')
    expect(enforcement.status(['summary-kept'])['summary-kept']!.hookContactAt).toEqual(expect.any(String))
  })

  it('gives hooks only to a TLDR registration’s own launch, never to inherited configs', async () => {
    const { host, register, hook } = await setup()
    const reporting = register('a')
    const other = register('c', ['orchestration'])
    expect(other.tldrHooks).toBeUndefined()
    // A session without TLDR is authenticated but has nothing to enforce.
    expect(await hook(other, other.bearerToken, 'stop')).toEqual({ status: 200, body: {} })
    // Workflow subagents reuse the parent's token; enforcing the parent's
    // summary on their turns would block work that owns no TLDR.
    expect(host.sessionServers('a')[0]?.tldrHooks).toBeUndefined()

    expect((await hook(reporting, reporting.bearerToken, 'not-an-event')).status).toBe(404)
    const get = await fetch(`${reporting.tldrHooks!.baseUrl}/stop`, { headers: { Authorization: `Bearer ${reporting.bearerToken}` } })
    expect(get.status).toBe(404)
  })
})
