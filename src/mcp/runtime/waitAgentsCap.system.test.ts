import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'

import { createBuiltInMcpServer } from '@mcp/runtime/createBuiltInMcpServer.js'

// #827. A Claude session waited on a two-child run with a generous timeout.
// The harness moved the MCP call to the background at 120 s, the transport
// dropped mid-call, and the tool's response was LOST:
//
//   MCP server "agent_code" transport dropped mid-call; response for tool
//   "orchestration_wait_agents" was lost
//
// The children were unaffected; a retry with 100 s returned normally. So any
// orchestration flow that waits past the harness's backgrounding threshold
// silently loses its wait result and has to fall back to polling
// `orchestration_list_agents` — a reliability failure in a first-party MCP
// surface, caused by us and not by the caller.
//
// The response already carried `done`, so the shape for polling existed. What
// was missing was a server-side bound that keeps the reply inside the window
// the caller can still receive it in.

function child(lifecycleState: string) {
  return { sessionId: 'child-1', kind: 'claude', cwd: '/repo', title: 'Child', lifecycleState, messageCount: 0 }
}

async function callWait(args: Record<string, unknown>, lifecycleState = 'running') {
  const listAgents = vi.fn(async () => [child(lifecycleState)])
  const server = createBuiltInMcpServer(
    { sessionId: 'parent', cwd: '/repo', domains: ['orchestration'] },
    {
      orchestrationBridge: {
        listAgents,
        readRunOutputs: vi.fn(async () => []),
      } as never,
    },
  )
  const client = new Client({ name: 'wait-cap-test', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const startedAt = Date.now()
    // The CLIENT's own request timeout is raised out of the way on purpose:
    // this suite is about the SERVER bounding its wait, and under fake timers
    // the client's default 60 s would fire first and hide that. (It firing is
    // itself a miniature of the reported bug — a transport that stops
    // listening while the tool is still working.)
    const result = await client.callTool(
      { name: 'orchestration_wait_agents', arguments: args },
      undefined,
      { timeout: 10_000_000 },
    )
    const elapsedMs = Date.now() - startedAt
    const text = (result.content as Array<{ text: string }>)[0]!.text
    return { payload: JSON.parse(text) as Record<string, unknown>, elapsedMs, listAgents }
  } finally {
    await client.close()
    await server.close()
  }
}

describe('orchestration_wait_agents stays inside the window its reply can survive (#827)', () => {
  it('caps a long wait and says it capped, so the caller polls instead of losing the reply', async () => {
    vi.useFakeTimers()
    try {
      // The reported call: a generous timeout on children that never settle.
      const pending = callWait({ timeoutMs: 600_000, pollIntervalMs: 1_000 })
      await vi.advanceTimersByTimeAsync(600_000)
      const { payload } = await pending

      // It returned, rather than running the full ten minutes into a transport
      // that is no longer listening.
      expect(payload.done).toBe(false)
      // And it SAYS the wait was shortened. A silently short wait is a second
      // surprise on top of the first: the caller asked for ten minutes.
      expect(payload.waitCappedMs).toBe(90_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('polls only up to the cap, never for the timeout the caller asked for', async () => {
    vi.useFakeTimers()
    try {
      const pending = callWait({ timeoutMs: 600_000, pollIntervalMs: 1_000 })
      await vi.advanceTimersByTimeAsync(600_000)
      const { listAgents } = await pending

      // One read before the loop, then one per poll inside the cap. Anything
      // near 600 means the cap did not bound the loop.
      expect(listAgents.mock.calls.length).toBeLessThanOrEqual(92)
      expect(listAgents.mock.calls.length).toBeGreaterThan(80)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves a timeout inside the cap exactly as it was', async () => {
    // The control. "Always return immediately" would satisfy the two above and
    // break every ordinary wait.
    vi.useFakeTimers()
    try {
      const pending = callWait({ timeoutMs: 30_000, pollIntervalMs: 1_000 })
      await vi.advanceTimersByTimeAsync(30_000)
      const { payload, listAgents } = await pending

      expect(payload.done).toBe(false)
      // No cap was applied, so the field is absent rather than reported as 0.
      expect(payload).not.toHaveProperty('waitCappedMs')
      expect(listAgents.mock.calls.length).toBeGreaterThan(25)
      expect(listAgents.mock.calls.length).toBeLessThanOrEqual(32)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns at once when the children are already done, whatever the timeout', async () => {
    const { payload, elapsedMs } = await callWait({ timeoutMs: 600_000 }, 'completed')

    expect(payload.done).toBe(true)
    expect(payload).not.toHaveProperty('waitCappedMs')
    expect(elapsedMs).toBeLessThan(5_000)
  })

  it('tells the caller about the cap in the tool description, not only in the reply', async () => {
    // An agent reads the description before it chooses a timeout. A cap it can
    // only discover by being capped is a cap it will keep being surprised by.
    const server = createBuiltInMcpServer({ sessionId: 'parent', cwd: '/repo', domains: ['orchestration'] })
    const client = new Client({ name: 'wait-cap-doc-test', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      const tool = (await client.listTools()).tools.find(item => item.name === 'orchestration_wait_agents')
      expect(tool?.description).toContain('90')
    } finally {
      await client.close()
      await server.close()
    }
  })
})
