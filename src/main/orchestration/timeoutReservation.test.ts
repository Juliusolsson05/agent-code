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

vi.mock('@main/window/windowRegistry.js', () => ({
  sendToWindow: (_windowId: string, _channel: string, request: Record<string, unknown>) => {
    sent.push(request)
  },
  windowForSession: (sessionId: string) => windowOwner(sessionId),
}))

const { OrchestrationBridge, OrchestrationOutcomeUnknownError } = await import('./OrchestrationBridge.js')

type Incident = { kind: string; context?: Record<string, unknown> }
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

describe('an identical retry is refused while the outcome is unknown', () => {
  it('does not dispatch a second create', async () => {
    const first = bridge.createAgent({ parentSessionId: 'parent-1', kind: 'claude', title: 'worker' })
    const firstSettled = first.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(30_000)
    await firstSettled
    const dispatched = sent.filter(request => request.type === 'create-agent').length

    const retry = await bridge.createAgent({ parentSessionId: 'parent-1', kind: 'claude', title: 'worker' })
      .catch((error: unknown) => error)

    expect(retry).toBeInstanceOf(OrchestrationOutcomeUnknownError)
    expect(sent.filter(request => request.type === 'create-agent')).toHaveLength(dispatched)
  })

  it('does not block a DIFFERENT create, or another parent', async () => {
    // The reservation is scoped to the request shape. An unreconciled create
    // for one worker must not stop the fleet.
    const stuck = bridge.createAgent({ parentSessionId: 'parent-1', kind: 'claude', title: 'worker' })
    const stuckSettled = stuck.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(30_000)
    await stuckSettled

    for (const params of [
      { parentSessionId: 'parent-1', kind: 'claude' as const, title: 'other worker' },
      { parentSessionId: 'parent-2', kind: 'claude' as const, title: 'worker' },
    ]) {
      const pending = bridge.createAgent(params)
      const request = lastSent('create-agent') as { requestId: string; title?: string }
      expect(request.title, JSON.stringify(params)).toBe(params.title)
      bridge.resolve({ requestId: request.requestId, ok: true, type: 'create-agent', agent: child(`child-${params.title}`, params.parentSessionId) } as never)
      await expect(pending).resolves.toMatchObject({ sessionId: `child-${params.title}` })
    }
  })

  it('does not block a READ for the same parent', async () => {
    const stuck = bridge.createAgent({ parentSessionId: 'parent-1', kind: 'claude' })
    const stuckSettled = stuck.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(30_000)
    await stuckSettled

    const list = bridge.listAgents({ parentSessionId: 'parent-1' })
    const request = lastSent('list-agents') as { requestId: string }
    bridge.resolve({ requestId: request.requestId, ok: true, type: 'list-agents', agents: [] } as never)
    await expect(list).resolves.toEqual([])
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

  it('releases the reservation once reconciled, so a new create may proceed', async () => {
    const create = bridge.createAgent({ parentSessionId: 'parent-1', kind: 'claude', title: 'worker' })
    const settled = create.catch((error: unknown) => error)
    const first = lastSent('create-agent') as { requestId: string }
    await vi.advanceTimersByTimeAsync(30_000)
    await settled
    bridge.resolve({ requestId: first.requestId, ok: true, type: 'create-agent', agent: child('child-late') } as never)

    const next = bridge.createAgent({ parentSessionId: 'parent-1', kind: 'claude', title: 'worker' })
    const second = lastSent('create-agent') as { requestId: string }
    expect(second.requestId).not.toBe(first.requestId)
    bridge.resolve({ requestId: second.requestId, ok: true, type: 'create-agent', agent: child('child-2') } as never)
    await expect(next).resolves.toMatchObject({ sessionId: 'child-2' })
  })

  it('keeps refusing while the answer never comes', async () => {
    // Deliberate: nothing about the passage of time proves the effect did not
    // happen, so the reservation is released by reconciliation and by nothing
    // else. A caller that wants to proceed must look at what exists.
    const create = bridge.createAgent({ parentSessionId: 'parent-1', kind: 'claude', title: 'worker' })
    const settled = create.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(30_000)
    await settled

    await vi.advanceTimersByTimeAsync(60 * 60_000)
    await expect(bridge.createAgent({ parentSessionId: 'parent-1', kind: 'claude', title: 'worker' }))
      .rejects.toBeInstanceOf(OrchestrationOutcomeUnknownError)
  })

  it('does not adopt a child from a FAILED late answer', async () => {
    const create = bridge.createAgent({ parentSessionId: 'parent-1', kind: 'claude' })
    const settled = create.catch((error: unknown) => error)
    const request = lastSent('create-agent') as { requestId: string }
    await vi.advanceTimersByTimeAsync(30_000)
    await settled

    bridge.resolve({ requestId: request.requestId, ok: false, message: 'no window' } as never)
    expect(incidents.map(incident => incident.kind)).not.toContain('orchestration.late_response_adopted')
  })
})
