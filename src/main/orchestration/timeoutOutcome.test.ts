import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// #926. The renderer request is sent BEFORE the 30 s timer starts, so when the
// timer fires it proves only that main stopped waiting — not that the renderer
// stopped working.
//
// The old code deleted the pending entry and rejected with a plain timeout.
// That threw away both halves of the truth:
//   - a late answer had nowhere to land, so a child that really was created
//     became an orphan the parent could neither see nor close; and
//   - the caller was told its create had FAILED, and the reasonable response
//     to a failure is to try again, turning one intended child into two.
//
// Fake timers, because the whole behaviour is defined by a 30 s deadline and
// waiting for it is not a test.
// ---------------------------------------------------------------------------

const sent: Array<Record<string, unknown>> = []
const windowOwner = vi.fn((_sessionId: string): string | null => 'window-1')
/** Whether the renderer actually received the send. `windowForSession` can
 *  hand back a window that delivery then skips — see the undelivered case. */
let delivers = true

vi.mock('@main/window/windowRegistry.js', () => ({
  sendToWindow: (_windowId: string, _channel: string, request: Record<string, unknown>) => {
    if (!delivers) return false
    sent.push(request)
    return true
  },
  windowForSession: (sessionId: string) => windowOwner(sessionId),
}))

const { OrchestrationBridge, OrchestrationOutcomeUnknownError } = await import('./OrchestrationBridge.js')

type Incident = { kind: string; reason?: string; context?: Record<string, unknown> }
let incidents: Incident[]
let bridge: InstanceType<typeof OrchestrationBridge>

/** The request the renderer was actually handed, by type. */
const lastSent = (type: string) => [...sent].reverse().find(request => request.type === type)

function child(sessionId: string, parentSessionId = 'parent-1') {
  return {
    sessionId, kind: 'claude' as const, cwd: '/tmp/project',
    orchestrationParentId: parentSessionId, orchestrationRootId: parentSessionId,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  sent.length = 0
  delivers = true
  incidents = []
  bridge = new OrchestrationBridge()
  bridge.setJournal({ recordIncident: (incident: Incident) => { incidents.push(incident) } } as never)
})
afterEach(() => { vi.useRealTimers() })

describe('a timed-out mutation reports an UNKNOWN outcome, not a failure (#926)', () => {
  it('tells the caller not to repeat it', async () => {
    const create = bridge.createAgent({ parentSessionId: 'parent-1', kind: 'claude' })
    const settled = create.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(30_000)

    const error = await settled
    expect(error).toBeInstanceOf(OrchestrationOutcomeUnknownError)
    expect((error as InstanceType<typeof OrchestrationOutcomeUnknownError>).outcome).toBe('unknown')
    // The wording is the contract: a caller that reads "failed" retries.
    expect(String(error)).toMatch(/UNKNOWN/)
    expect(String(error)).toMatch(/do not repeat/i)
  })

  it('still fails a timed-out READ plainly, because nothing happened', async () => {
    const read = bridge.listAgents({ parentSessionId: 'parent-1' })
    const settled = read.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(30_000)

    const error = await settled
    expect(error).not.toBeInstanceOf(OrchestrationOutcomeUnknownError)
    expect(String(error)).toMatch(/Timed out/)
  })
})

describe('a request nobody received is SAFE to retry (#926)', () => {
  // `windowForSession` resolves through a lease check that deliberately
  // ignores `closing`, while delivery skips a closing window. So a request
  // could be dropped, waited on for the full 30 s, and then reported as an
  // UNKNOWN outcome — the worst possible answer for the one case we can be
  // certain about. A ⌘W whose close is then vetoed reaches exactly this state.
  it('fails immediately, and says retrying is safe', async () => {
    delivers = false
    const create = bridge.createAgent({ parentSessionId: 'parent-1', kind: 'claude' })
    const error = await create.catch((reason: unknown) => reason)

    expect(error).not.toBeInstanceOf(OrchestrationOutcomeUnknownError)
    expect(String(error)).toMatch(/nothing was dispatched/)
    expect(String(error)).toMatch(/safe to retry/)
  })

  it('does not wait for the deadline to say so', async () => {
    // Waiting 30 s to report something knowable immediately is its own bug:
    // the caller is blocked, and the queue slot with it.
    delivers = false
    let settled = false
    void bridge.createAgent({ parentSessionId: 'parent-1', kind: 'claude' })
      .catch(() => { settled = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
  })

  it('records it as undispatched, not as a renderer hang', async () => {
    delivers = false
    await bridge.createAgent({ parentSessionId: 'parent-1', kind: 'claude' }).catch(() => {})
    expect(incidents.map(incident => incident.context?.dispatched)).toEqual([false])
  })

  it('frees the queue so the next request proceeds', async () => {
    delivers = false
    await bridge.createAgent({ parentSessionId: 'parent-1', kind: 'claude' }).catch(() => {})
    delivers = true
    const next = bridge.createAgent({ parentSessionId: 'parent-1', kind: 'claude' })
    const request = lastSent('create-agent') as { requestId: string }
    bridge.resolve({ requestId: request.requestId, ok: true, type: 'create-agent', agent: child('child-1') } as never)
    await expect(next).resolves.toMatchObject({ sessionId: 'child-1' })
  })
})

describe('a timed-out mutation does not block the next one', () => {
  it('lets an identical create through, because refusing it had no legal exit', async () => {
    // A first version held a reservation and refused any matching retry.
    // Review proved that unsound: the renderer request has no `prompt` field,
    // so two different fan-out jobs share a shape and the second was refused
    // FOREVER — and nothing could clear it, so a parent that followed the
    // error's own instruction looped. Refusing here is worse than the
    // duplicate it was trying to prevent; `createAgentCallOnce` at the MCP
    // layer is where a sound guard belongs, because it can see the prompt.
    const first = bridge.createAgent({ parentSessionId: 'parent-1', kind: 'claude', title: 'worker' })
    const settled = first.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(30_000)
    await settled

    const retry = bridge.createAgent({ parentSessionId: 'parent-1', kind: 'claude', title: 'worker' })
    const request = lastSent('create-agent') as { requestId: string }
    bridge.resolve({ requestId: request.requestId, ok: true, type: 'create-agent', agent: child('child-2') } as never)
    await expect(retry).resolves.toMatchObject({ sessionId: 'child-2' })
  })
})

describe('a late answer is reconciled, never dropped', () => {
  it('adopts a child the renderer created after we gave up', async () => {
    // Without this the child exists in the workspace and nowhere in the
    // bridge: invisible to list_agents, unclosable, and still running.
    const create = bridge.createAgent({ parentSessionId: 'parent-1', kind: 'claude' })
    const settled = create.catch((error: unknown) => error)
    const request = lastSent('create-agent') as { requestId: string }
    await vi.advanceTimersByTimeAsync(30_000)
    await settled

    bridge.resolve({ requestId: request.requestId, ok: true, type: 'create-agent', agent: child('child-late') } as never)

    // Discoverable: the bridge now owns it, so a list for this parent is
    // refreshed and the child can be closed.
    expect(incidents.map(incident => incident.kind)).toContain('orchestration.late_response_adopted')
    const adopted = incidents.find(incident => incident.kind === 'orchestration.late_response_adopted')
    expect(adopted?.context).toMatchObject({ sessionId: 'child-late', parentSessionId: 'parent-1' })
  })

  it('does not adopt a child from a FAILED late answer', async () => {
    const create = bridge.createAgent({ parentSessionId: 'parent-1', kind: 'claude' })
    const settled = create.catch((error: unknown) => error)
    const request = lastSent('create-agent') as { requestId: string }
    await vi.advanceTimersByTimeAsync(30_000)
    await settled

    // A real failed answer carries its type (review of #1375, b: without it the fixture never
    // reached the `!response.ok` guard, and removing that guard survived).
    bridge.resolve({ requestId: request.requestId, ok: false, type: 'create-agent', message: 'no window' } as never)
    expect(incidents.map(incident => incident.kind)).not.toContain('orchestration.late_response_adopted')
  })
})

// #1370: a healthy provider can take longer than the 30 s deadline to start. The timed-out create
// told the caller "do not repeat", and the late child was adopted idle, without the brief the
// create promised. The create's own bootstrap delivery now runs when the late answer is adopted.
describe('a late-created child still gets its bootstrap prompt (#1370)', () => {
  it('runs the create\'s late continuation once, with the adopted child, and says so up front', async () => {
    const late = vi.fn(async (_agent: { sessionId: string }) => {})
    const create = bridge.createAgent({ parentSessionId: 'parent-1', kind: 'claude', onLateCreate: late })
    const settled = create.catch((error: unknown) => error)
    const request = lastSent('create-agent') as { requestId: string; onLateCreate?: unknown }
    // The continuation is main-side only; the renderer never sees it.
    expect(request).not.toHaveProperty('onLateCreate')
    await vi.advanceTimersByTimeAsync(30_000)
    const error = await settled
    expect(error).toBeInstanceOf(OrchestrationOutcomeUnknownError)
    // Otherwise the parent's next move — sending the brief once list_agents shows the child —
    // would deliver it twice.
    expect(String(error)).toMatch(/delivers its bootstrap prompt to it automatically/)
    expect(String(error)).toMatch(/Check orchestration_read_agent for promptSubmitted before sending it yourself/)
    expect(late).not.toHaveBeenCalled()

    bridge.resolve({ requestId: request.requestId, ok: true, type: 'create-agent', agent: child('child-late') } as never)
    await vi.advanceTimersByTimeAsync(0)
    expect(late).toHaveBeenCalledTimes(1)
    expect(late.mock.calls[0]![0]).toMatchObject({ sessionId: 'child-late' })
    const adopted = incidents.find(incident => incident.kind === 'orchestration.late_response_adopted')
    expect(adopted?.context).toMatchObject({ bootstrapFollows: true })
  })

  it('runs nothing for a FAILED late answer', async () => {
    const late = vi.fn(async () => {})
    const create = bridge.createAgent({ parentSessionId: 'parent-1', kind: 'claude', onLateCreate: late })
    const settled = create.catch((error: unknown) => error)
    const request = lastSent('create-agent') as { requestId: string }
    await vi.advanceTimersByTimeAsync(30_000)
    await settled
    // A real failed answer carries its type (review of #1375, b: without it the fixture never
    // reached the `!response.ok` guard, and removing that guard survived).
    bridge.resolve({ requestId: request.requestId, ok: false, type: 'create-agent', message: 'no window' } as never)
    await vi.advanceTimersByTimeAsync(0)
    expect(late).not.toHaveBeenCalled()
  })

  it('never runs it for a create that answered in time', async () => {
    const late = vi.fn(async () => {})
    const create = bridge.createAgent({ parentSessionId: 'parent-1', kind: 'claude', onLateCreate: late })
    const request = lastSent('create-agent') as { requestId: string }
    bridge.resolve({ requestId: request.requestId, ok: true, type: 'create-agent', agent: child('child-fast') } as never)
    await expect(create).resolves.toMatchObject({ sessionId: 'child-fast' })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(late).not.toHaveBeenCalled()
  })

  // Review of #1375 (a): the parent closed while the renderer was spawning.
  // Its brief must not start an ownerless agent.
  it('runs nothing when the parent is gone by the time the child arrives', async () => {
    const late = vi.fn(async () => {})
    const create = bridge.createAgent({ parentSessionId: 'parent-1', kind: 'claude', onLateCreate: late })
    const settled = create.catch((error: unknown) => error)
    const request = lastSent('create-agent') as { requestId: string }
    await vi.advanceTimersByTimeAsync(30_000)
    await settled
    windowOwner.mockImplementation(sessionId => (sessionId === 'parent-1' ? null : 'window-1'))
    try {
      bridge.resolve({ requestId: request.requestId, ok: true, type: 'create-agent', agent: child('child-late') } as never)
      await vi.advanceTimersByTimeAsync(0)
      expect(late).not.toHaveBeenCalled()
      const skipped = incidents.find(incident => incident.reason === 'create_agent_late_bootstrap_parent_gone')
      expect(skipped?.context).toMatchObject({ sessionId: 'child-late', parentSessionId: 'parent-1' })
    } finally {
      windowOwner.mockImplementation(() => 'window-1')
    }
  })

  it('reports a late delivery that throws as an incident instead of losing it', async () => {
    const create = bridge.createAgent({
      parentSessionId: 'parent-1', kind: 'claude', onLateCreate: async () => { throw new Error('composer gone') },
    })
    const settled = create.catch((error: unknown) => error)
    const request = lastSent('create-agent') as { requestId: string }
    await vi.advanceTimersByTimeAsync(30_000)
    await settled
    bridge.resolve({ requestId: request.requestId, ok: true, type: 'create-agent', agent: child('child-late') } as never)
    await vi.advanceTimersByTimeAsync(0)
    const failed = incidents.find(incident => incident.kind === 'orchestration.prompt_delivery_failed')
    expect(failed?.context).toMatchObject({ sessionId: 'child-late', message: 'composer gone' })
  })

  // Review of #1375 (b), a surviving mutation: removing every `lateCreates.delete` passed. The
  // bridge is long-lived, and each create's continuation captures its brief and handler, so the
  // map must empty however the create ends.
  it('forgets every create continuation once the create is settled, in time or late', async () => {
    const lateCreates = (bridge as unknown as { lateCreates: Map<string, unknown> }).lateCreates
    const late = vi.fn(async () => {})
    const fast = bridge.createAgent({ parentSessionId: 'parent-1', kind: 'claude', onLateCreate: late })
    const fastRequest = lastSent('create-agent') as { requestId: string }
    bridge.resolve({ requestId: fastRequest.requestId, ok: true, type: 'create-agent', agent: child('child-fast') } as never)
    await fast
    expect(lateCreates.size).toBe(0)

    const slow = bridge.createAgent({ parentSessionId: 'parent-1', kind: 'claude', onLateCreate: late })
    const settled = slow.catch((error: unknown) => error)
    const slowRequest = lastSent('create-agent') as { requestId: string }
    await vi.advanceTimersByTimeAsync(30_000)
    await settled
    expect(lateCreates.size).toBe(1)
    bridge.resolve({ requestId: slowRequest.requestId, ok: true, type: 'create-agent', agent: child('child-late') } as never)
    await vi.advanceTimersByTimeAsync(0)
    expect(lateCreates.size).toBe(0)
  })
})
