import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// #952. On 2026-09-12 one `orchestration_create_agent` call produced TWO
// children 0.9 s apart — same title, cwd, role and prompt, both bootstrapped,
// both working in the same worktree and writing the same report path. Only one
// was returned, so the parent could neither see nor close the other.
//
// These drive the REAL MCP server, the REAL tool handler and the REAL
// OrchestrationBridge over an in-memory transport. Only the two true edges are
// faked: `sendToWindow` (there is no renderer here) and `deliverPromptToAgent`
// (there is no provider process) — and the delivery fake reproduces
// SessionManager's real in-flight reservation, because the failure mode found
// in review is precisely a duplicate colliding with it.
//
// The whole tool CALL is the unit under test, not `createAgent`: one
// invocation is create → deliver the bootstrap prompt → mark delivered, and a
// duplicate that arrives during the delivery must not start a second child.
// ---------------------------------------------------------------------------

const renderer = {
  requests: [] as Array<Record<string, unknown>>,
  children: 0,
}

vi.mock('@main/window/windowRegistry.js', () => ({
  windowForSession: () => 'test-window',
  sendToWindow: (_windowId: string, _channel: string, request: Record<string, unknown>) => {
    renderer.requests.push(request)
    // Answer as the renderer does, on a later tick — the gap is where a
    // duplicate arrives, so resolving synchronously would hide the bug.
    queueMicrotask(() => {
      const type = request.type as string
      if (type === 'create-agent') {
        renderer.children += 1
        bridge.resolve({
          requestId: request.requestId as string,
          ok: true,
          type: 'create-agent',
          agent: {
            sessionId: `child-${renderer.children}`,
            kind: 'claude',
            cwd: (request.cwd as string) ?? '/tmp/project',
            orchestrationParentId: 'parent-1',
            orchestrationRootId: 'parent-1',
            ...(request.title ? { title: request.title } : {}),
          },
        } as never)
        return
      }
      if (type === 'mark-bootstrap-prompt-delivered') {
        bridge.resolve({
          requestId: request.requestId as string,
          ok: true,
          type: 'mark-bootstrap-prompt-delivered',
          agent: {
            sessionId: request.sessionId as string,
            kind: 'claude',
            cwd: '/tmp/project',
            orchestrationParentId: 'parent-1',
            orchestrationRootId: 'parent-1',
          },
        } as never)
        return
      }
      bridge.resolve({ requestId: request.requestId as string, ok: true, type, agents: [] } as never)
    })
  },
}))

const { OrchestrationBridge } = await import('@main/orchestration/OrchestrationBridge.js')
const { createBuiltInMcpServer } = await import('@mcp/runtime/createBuiltInMcpServer.js')

let bridge: InstanceType<typeof OrchestrationBridge>
/** Which child each delivery went to, in order. */
let deliveries: string[]
/** SessionManager's real reservation: one delivery per session at a time. */
let deliveriesInFlight: Set<string>
let deliveryFails: boolean

function manager() {
  return {
    deliverPromptToAgent: vi.fn(async (sessionId: string) => {
      if (deliveriesInFlight.has(sessionId)) {
        return {
          ok: false as const,
          message: `A prompt delivery is already in flight for session ${sessionId}`,
          stage: 'reserve', code: 'delivery-in-flight',
          retrySafe: true, disposition: 'retry-same-session' as const,
          promptWritten: false, enterWritten: false,
        }
      }
      deliveriesInFlight.add(sessionId)
      try {
        await Promise.resolve()
        deliveries.push(sessionId)
        if (deliveryFails) {
          return {
            ok: false as const, message: 'provider never painted',
            stage: 'submit', code: 'composer-unpainted',
            retrySafe: true, disposition: 'retry-same-session' as const,
            promptWritten: false, enterWritten: false,
          }
        }
        return { ok: true as const }
      } finally {
        deliveriesInFlight.delete(sessionId)
      }
    }),
  }
}

type CallArgs = Record<string, unknown>

async function callAll(calls: CallArgs[], parentSessionId = 'parent-1'): Promise<Array<Record<string, unknown>>> {
  const server = createBuiltInMcpServer(
    { sessionId: parentSessionId, cwd: '/tmp/project', domains: ['orchestration'] },
    { orchestrationBridge: bridge as never, sessionManager: manager() as never },
  )
  const client = new Client({ name: 'dup-create-test', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const results = await Promise.all(calls.map(args => client.callTool({
      name: 'orchestration_create_agent',
      arguments: args,
    })))
    return results.map(result => {
      // The handler answers with JSON; a THROWN failure (an unsupported
      // runtime, say) crosses the boundary as the error's plain text. Keep
      // both, so a test can assert on either without the harness deciding.
      const text = ((result.content as Array<{ text: string }>)[0]!).text
      try {
        return JSON.parse(text) as Record<string, unknown>
      } catch {
        return { ok: false, text }
      }
    })
  } finally {
    await client.close()
    await server.close()
  }
}

/** How many children the renderer was actually asked to create. */
const created = () => renderer.requests.filter(request => request.type === 'create-agent').length

beforeEach(() => {
  renderer.requests = []
  renderer.children = 0
  deliveries = []
  deliveriesInFlight = new Set()
  deliveryFails = false
  bridge = new OrchestrationBridge()
})
afterEach(() => { vi.restoreAllMocks() })

describe('a duplicate create must not spawn a second child (#952)', () => {
  it('collapses two identical concurrent calls into one child', async () => {
    const args = { kind: 'claude', title: 'Review #1069', cwd: '/tmp/project', prompt: 'review it' }
    const [first, second] = await callAll([args, { ...args }])

    expect(created()).toBe(1)
    expect(deliveries).toEqual(['child-1'])
    // Both callers get the SAME successful answer. Deduping only the create
    // used to leave the duplicate colliding with the first call's prompt
    // delivery and receiving `prompt_delivery_failed` with
    // `disposition: 'retry-same-session'` — an instruction to re-send the
    // prompt into the child already running it.
    expect(first).toMatchObject({ ok: true, promptSubmitted: true })
    expect(second).toEqual(first)
  })

  it('collapses a duplicate with NO prompt just the same', async () => {
    const args = { kind: 'claude', title: 'worker' }
    const [first, second] = await callAll([args, { ...args }])
    expect(created()).toBe(1)
    expect(first).toMatchObject({ ok: true })
    expect(second).toEqual(first)
  })
})

describe('a deliberate fan-out is NOT a duplicate', () => {
  it('gives every concurrent prompt its own child', async () => {
    // The regression the first version of this fix introduced. Every field but
    // `kind` is optional, so N workers differing only by prompt shared one key
    // and N-1 tasks were silently never run. `MAX_ACTIVE_RENDERER_REQUESTS = 1`
    // makes such a burst overlap in flight by construction, so a fan-out was
    // the MOST exposed shape, not the least.
    const results = await callAll([
      { kind: 'claude', prompt: 'Review PR #1001' },
      { kind: 'claude', prompt: 'Review PR #1002' },
      { kind: 'claude', prompt: 'Review PR #1003' },
    ])
    expect(created()).toBe(3)
    expect(deliveries).toEqual(['child-1', 'child-2', 'child-3'])
    expect(results.map(result => result.ok)).toEqual([true, true, true])
    expect(new Set(results.map(result => (result.agent as { sessionId: string }).sessionId)).size).toBe(3)
  })

  // Every field that distinguishes one requested child from another. A field
  // missing from the key does not fail loudly — it silently drops a job, and
  // review found five of these unconstrained in the first version.
  const base = { kind: 'claude', prompt: 'go', cwd: '/tmp/a', title: 't', role: 'r', runId: 'run-1' }
  const differing: Array<[string, Record<string, unknown>]> = [
    ['cwd', { cwd: '/tmp/b' }],
    ['title', { title: 'other' }],
    ['role', { role: 'reviewer' }],
    ['runId', { runId: 'run-2' }],
    ['prompt', { prompt: 'something else' }],
    ['kind', { kind: 'codex' }],
    ['builtInMcpDomains', { builtInMcpDomains: ['tldr'] }],
  ]
  for (const [field, override] of differing) {
    it(`does not collapse two calls that differ by ${field}`, async () => {
      await callAll([base, { ...base, ...override }])
      expect(created()).toBe(2)
    })
  }

  it('does not collapse a terminal-runtime create with a structured one', async () => {
    // A `terminal` child is the provider's native TUI. Collapsing these hands
    // the caller the wrong runtime entirely.
    //
    // Asserted through the OUTCOMES rather than a child count, because in this
    // process the provider registry has no terminal factory, so the terminal
    // call is rejected before it ever reaches the renderer. That makes the
    // point sharper: if the two shared a key, BOTH callers would get the same
    // answer. They do not.
    const results = await Promise.allSettled([
      callAll([{ kind: 'claude', prompt: 'go' }]),
      callAll([{ kind: 'claude', prompt: 'go', providerRuntime: 'terminal' }]),
    ])
    const [structured, terminal] = results
    expect(structured.status).toBe('fulfilled')
    expect((structured as PromiseFulfilledResult<Array<Record<string, unknown>>>).value[0])
      .toMatchObject({ ok: true })
    // The terminal arm fails on its own merits — never by inheriting the
    // structured arm's success.
    const terminalText = terminal.status === 'rejected'
      ? String((terminal.reason as Error).message)
      : JSON.stringify(terminal.value)
    expect(terminalText).toMatch(/terminal runtime/i)
    expect(created()).toBe(1)
  })
})

describe('the key names the child, not the spelling of the request', () => {
  it('treats the same domains in a different order as one call', async () => {
    await callAll([
      { kind: 'claude', prompt: 'go', builtInMcpDomains: ['orchestration', 'tldr'] },
      { kind: 'claude', prompt: 'go', builtInMcpDomains: ['tldr', 'orchestration'] },
    ])
    expect(created()).toBe(1)
  })

  it('keeps two parents\' identical calls apart', async () => {
    // The key is scoped to the PARENT. Two orchestrators asking for the same
    // thing at the same time are two jobs, and one of them silently losing its
    // child would be the same failure this fix exists to prevent.
    const args = { kind: 'claude', prompt: 'go', title: 'worker' }
    await Promise.all([callAll([args], 'parent-1'), callAll([args], 'parent-2')])
    expect(created()).toBe(2)
  })

  it('treats an empty domain list and an absent one as one call', async () => {
    // Downstream both mean "no domains" — SessionManager gates on length > 0.
    await callAll([
      { kind: 'claude', prompt: 'go' },
      { kind: 'claude', prompt: 'go', builtInMcpDomains: [] },
    ])
    expect(created()).toBe(1)
  })
})

describe('the window is IN FLIGHT only', () => {
  it('lets an identical call run again once the first has finished', async () => {
    // "Run that exact task again" is legitimate. Only an overlap is a
    // duplicate, so a completed-call window would swallow a real request.
    const args = { kind: 'claude', prompt: 'go' }
    await callAll([args])
    await callAll([args])
    expect(created()).toBe(2)
  })

  it('does not let a failed call poison the next identical one', async () => {
    deliveryFails = true
    const args = { kind: 'claude', prompt: 'go' }
    const [failed] = await callAll([args])
    expect(failed).toMatchObject({ ok: false, error: 'prompt_delivery_failed' })

    deliveryFails = false
    const [retried] = await callAll([args])
    expect(retried).toMatchObject({ ok: true })
    expect(created()).toBe(2)
  })
})
