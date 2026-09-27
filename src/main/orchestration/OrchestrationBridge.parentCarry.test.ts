import { expect, it, vi } from 'vitest'

// #1283 item 1. A child closed through the orchestration MCP leaves a
// tombstone in main that names its parent P. When P is replaced by P' (reload,
// provider switch, resume, rewind, Reload Agents, rehydrate), the renderer
// remaps every LIVE child to P' but main was never told, so P' lost sight of
// every closed child: list_agents and read_run_outputs omitted them, and
// read_agent said not-found.
const sent: Array<{ requestId: string; type: string; parentSessionId?: string; sessionId?: string }> = []

vi.mock('@main/window/windowRegistry.js', () => ({
  sendToWindow: (_windowId: string, _channel: string, request: never) => {
    sent.push(request)
    return true
  },
  windowForSession: () => 'test-window',
}))

const { OrchestrationBridge } = await import('@main/orchestration/OrchestrationBridge.js')
type Bridge = InstanceType<typeof OrchestrationBridge>

const agent = (sessionId: string, parent: string, root = parent) => ({
  sessionId, kind: 'claude' as const, cwd: '/tmp/project',
  orchestrationParentId: parent, orchestrationRootId: root, orchestrationRunId: 'run-1',
  lifecycleState: 'completed' as const, statusSummary: 'done',
})

async function next(type: string) {
  await vi.waitFor(() => expect(sent.some(request => request.type === type)).toBe(true))
  const index = sent.findIndex(request => request.type === type)
  return sent.splice(index, 1)[0]!
}

/** The real close flow: main reads the child first, then asks the renderer to
 *  close it, and tombstones the read. `beforeClose` runs between the two. */
async function closeChild(bridge: Bridge, parent: string, child: ReturnType<typeof agent>, beforeClose?: () => void) {
  const closing = bridge.closeAgent({ parentSessionId: parent, sessionId: child.sessionId })
  const read = await next('read-agent')
  bridge.resolve({ requestId: read.requestId, ok: true, type: 'read-agent', output: { agent: child, messages: [], finalAssistantText: 'finished' } } as never)
  const close = await next('close-agent')
  beforeClose?.()
  bridge.resolve({ requestId: close.requestId, ok: true, type: 'close-agent', result: { closedSessionIds: [child.sessionId] } } as never)
  await closing
}

async function listFor(bridge: Bridge, parent: string) {
  const listing = bridge.listAgents({ parentSessionId: parent })
  const request = await next('list-agents')
  bridge.resolve({ requestId: request.requestId, ok: true, type: 'list-agents', agents: [] } as never)
  return (await listing).map(row => [row.sessionId, row.orchestrationParentId, row.lifecycleState])
}

async function readFor(bridge: Bridge, parent: string, sessionId: string) {
  const reading = bridge.readAgent({ parentSessionId: parent, sessionId })
  const request = await next('read-agent')
  // The pane is gone, so the renderer cannot find the child.
  bridge.resolve({ requestId: request.requestId, ok: false, type: 'read-agent', message: 'not found' } as never)
  return await reading
}

it('shows a closed child to the parent\'s successor after the parent is replaced', async () => {
  sent.length = 0
  const bridge = new OrchestrationBridge()
  await closeChild(bridge, 'parent-a', agent('child-1', 'parent-a'))

  bridge.carryParent('parent-a', 'parent-b')

  expect(await listFor(bridge, 'parent-b')).toEqual([['child-1', 'parent-b', 'closed']])
  expect((await readFor(bridge, 'parent-b', 'child-1')).agent).toMatchObject({ sessionId: 'child-1', orchestrationParentId: 'parent-b', orchestrationRootId: 'parent-b' })
  const outputs = bridge.readRunOutputs({ parentSessionId: 'parent-b', runId: 'run-1' })
  const request = await next('read-run-outputs')
  bridge.resolve({ requestId: request.requestId, ok: true, type: 'read-run-outputs', outputs: [] } as never)
  expect((await outputs).map(output => output.agent.sessionId)).toEqual(['child-1'])
  // The replaced id no longer owns it.
  expect(await listFor(bridge, 'parent-a')).toEqual([])
})

// closeAgent reads the child BEFORE the renderer closes it; a replacement in
// between hands the tombstone a record that still names the old parent.
it('files a close that straddles the replacement under the successor', async () => {
  sent.length = 0
  const bridge = new OrchestrationBridge()
  await closeChild(bridge, 'parent-a', agent('child-1', 'parent-a'), () => bridge.carryParent('parent-a', 'parent-b'))

  expect(await listFor(bridge, 'parent-b')).toEqual([['child-1', 'parent-b', 'closed']])
})

it('follows a parent replaced twice, and stops on a cycle', async () => {
  sent.length = 0
  const bridge = new OrchestrationBridge()
  bridge.carryParent('parent-a', 'parent-b')
  bridge.carryParent('parent-b', 'parent-c')
  // A grandchild rooted at the replaced parent, closed after both swaps from a
  // stale read.
  await closeChild(bridge, 'child-1', agent('grandchild', 'child-1', 'parent-a'))
  expect((await readFor(bridge, 'child-1', 'grandchild')).agent).toMatchObject({ orchestrationParentId: 'child-1', orchestrationRootId: 'parent-c' })

  // parent-a comes back as a live pane (Undo Close can do this). Its old edge
  // out (a -> b) must go: otherwise a child it closes now would be filed
  // under b, and the edges would form a loop.
  bridge.carryParent('parent-c', 'parent-a')
  await closeChild(bridge, 'parent-c', agent('child-2', 'parent-c'))
  await closeChild(bridge, 'parent-a', agent('child-3', 'parent-a'))
  expect(await listFor(bridge, 'parent-a')).toEqual([
    ['grandchild', 'child-1', 'closed'], ['child-2', 'parent-a', 'closed'], ['child-3', 'parent-a', 'closed'],
  ])
})

// The child -> parent hint decides whose status cache a child's prompt
// boundary invalidates. After the swap it must be the successor's, or the
// successor keeps serving a status computed before the child changed.
it('invalidates the successor\'s status cache when a child of the replaced parent changes', async () => {
  sent.length = 0
  const bridge = new OrchestrationBridge()
  const created = bridge.createAgent({ parentSessionId: 'parent-a', kind: 'claude' })
  const create = await next('create-agent')
  bridge.resolve({ requestId: create.requestId, ok: true, type: 'create-agent', agent: agent('child-1', 'parent-a') } as never)
  await created
  bridge.carryParent('parent-a', 'parent-b')
  // Fill parent-b's cache. Another (unrelated) child's unknown hint would
  // clear every cache, so only child-1's hint is exercised.
  await listFor(bridge, 'parent-b')
  bridge.notePromptSubmitted('child-1')
  void bridge.listAgents({ parentSessionId: 'parent-b' })
  await vi.waitFor(() => expect(sent.some(request => request.type === 'list-agents' && request.parentSessionId === 'parent-b')).toBe(true))
})

// #1369 review a: a create requested under A and answered after A became B.
// B polls meanwhile and caches what it saw; when the create finally answers,
// the child's hint must name B and B's cache must be dropped, or wait_agents
// on B keeps reporting the cached list (done) while the child runs. The
// bridge serves one renderer request at a time, so B's poll is answered
// before the create is dispatched; fake timers freeze the 250 ms cache so
// only an invalidation, never expiry, can send the next poll to the renderer.
it('files a child whose create is answered after the parent was replaced under the successor', async () => {
  sent.length = 0
  vi.useFakeTimers()
  try {
    const bridge = new OrchestrationBridge()
    bridge.carryParent('parent-a', 'parent-b')
    const listing = bridge.listAgents({ parentSessionId: 'parent-b' })
    await vi.advanceTimersByTimeAsync(0)
    const list = sent.splice(sent.findIndex(request => request.type === 'list-agents'), 1)[0]!
    bridge.resolve({ requestId: list.requestId, ok: true, type: 'list-agents', agents: [] } as never)
    expect(await listing).toEqual([])

    // A's in-flight create_agent call, answered after the swap.
    const created = bridge.createAgent({ parentSessionId: 'parent-a', kind: 'claude' })
    await vi.advanceTimersByTimeAsync(0)
    const create = sent.splice(sent.findIndex(request => request.type === 'create-agent'), 1)[0]!
    bridge.resolve({ requestId: create.requestId, ok: true, type: 'create-agent', agent: agent('child-1', 'parent-a') } as never)
    await created
    expect((bridge as unknown as { parentSessionByChildSession: Map<string, string> }).parentSessionByChildSession.get('child-1')).toBe('parent-b')

    void bridge.listAgents({ parentSessionId: 'parent-b' })
    await vi.advanceTimersByTimeAsync(0)
    expect(sent.some(request => request.type === 'list-agents' && request.parentSessionId === 'parent-b')).toBe(true)
  } finally {
    vi.useRealTimers()
  }
})

// The same, for a create that timed out and is adopted when the renderer
// finally answers (adoptLateResponse).
it('files a late-adopted child under the parent\'s successor', async () => {
  sent.length = 0
  vi.useFakeTimers()
  try {
    const bridge = new OrchestrationBridge()
    const created = bridge.createAgent({ parentSessionId: 'parent-a', kind: 'claude' }).catch(error => error)
    await vi.advanceTimersByTimeAsync(0)
    const create = sent.find(request => request.type === 'create-agent')!
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await created).toBeInstanceOf(Error)
    bridge.carryParent('parent-a', 'parent-b')
    bridge.resolve({ requestId: create.requestId, ok: true, type: 'create-agent', agent: agent('child-1', 'parent-a') } as never)
    expect((bridge as unknown as { parentSessionByChildSession: Map<string, string> }).parentSessionByChildSession.get('child-1')).toBe('parent-b')
  } finally {
    vi.useRealTimers()
  }
})

// #1369 reviews a and b (surviving mutants): the alias map is bounded like the
// tombstones it serves, by the same 24 h TTL and 500-entry cap.
it('forgets aliases after the tombstone TTL and keeps at most 500', async () => {
  vi.useFakeTimers()
  try {
    const bridge = new OrchestrationBridge()
    const aliases = (bridge as unknown as { replacedParents: Map<string, unknown> }).replacedParents
    bridge.carryParent('parent-old', 'parent-new')
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000 + 1)
    bridge.carryParent('parent-x', 'parent-y')
    expect(aliases.has('parent-old')).toBe(false)
    expect(aliases.has('parent-x')).toBe(true)

    for (let i = 0; i < 510; i++) bridge.carryParent(`pane-${i}`, `pane-${i}-next`)
    expect(aliases.size).toBe(500)
    expect(aliases.has('pane-509')).toBe(true)
    expect(aliases.has('pane-0')).toBe(false)
  } finally {
    vi.useRealTimers()
  }
})

// #1369 review c: the carry drops both parents' status caches. The successor
// may have cached "no closed children" in the spawn -> commit window, before
// the carry landed; the replaced id may still hold the list that owned them.
// Fake timers freeze the 250 ms cache, so only the invalidation can send the
// next poll to the renderer.
it.each(['parent-a', 'parent-b'])('drops %s\'s cached status when the parent is carried', async parent => {
  sent.length = 0
  vi.useFakeTimers()
  try {
    const bridge = new OrchestrationBridge()
    const listing = bridge.listAgents({ parentSessionId: parent })
    await vi.advanceTimersByTimeAsync(0)
    const list = sent.splice(sent.findIndex(request => request.type === 'list-agents'), 1)[0]!
    bridge.resolve({ requestId: list.requestId, ok: true, type: 'list-agents', agents: [] } as never)
    await listing
    bridge.carryParent('parent-a', 'parent-b')
    void bridge.listAgents({ parentSessionId: parent })
    await vi.advanceTimersByTimeAsync(0)
    expect(sent.some(request => request.type === 'list-agents' && request.parentSessionId === parent)).toBe(true)
  } finally {
    vi.useRealTimers()
  }
})

// q85: a bootstrap mark is the last step of a delivery that can land long
// after the create began (a prompt that waited for the child's composer, or a
// create adopted late, #1370). It is addressed with the parent id the tool
// call captured; after a replacement that id has no window and owns no
// children in the renderer, so the mark must go to the successor.
it('addresses a bootstrap mark from a replaced parent to its successor', async () => {
  sent.length = 0
  const bridge = new OrchestrationBridge()
  bridge.carryParent('parent-a', 'parent-b')
  const marking = bridge.markBootstrapPromptDelivered({ parentSessionId: 'parent-a', sessionId: 'child-1' })
  const mark = await next('mark-bootstrap-prompt-delivered')
  expect(mark.parentSessionId).toBe('parent-b')
  bridge.resolve({ requestId: mark.requestId, ok: true, type: 'mark-bootstrap-prompt-delivered', agent: agent('child-1', 'parent-b') } as never)
  expect(await marking).toMatchObject({ sessionId: 'child-1', orchestrationParentId: 'parent-b' })
})
