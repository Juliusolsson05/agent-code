import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SESSION_LIFECYCLE_AREA } from '@shared/lifecycle/events.js'

// Mirrors the mock preamble in sessionManager.recover.test.ts. Kept as a
// separate file rather than appended there because these assertions are about
// the DIAGNOSTIC stream, not about ownership correctness — mixing them would
// make a future reader unsure which failures mean "recovery is broken" and
// which mean "we stopped recording something".
const { createSession, deliverPrompt } = vi.hoisted(() => ({
  createSession: vi.fn(),
  deliverPrompt: vi.fn(),
}))

vi.mock('@providers/registry.main.js', () => ({
  getMainProvider: () => ({ createSession, deliverPrompt }),
}))

vi.mock('@main/setup/toolchain.js', () => ({
  getToolPath: () => '/usr/bin/true',
}))

vi.mock('@main/performance/PerformanceService.js', () => ({
  performanceService: { mark: vi.fn(), record: vi.fn(), error: vi.fn() },
}))

vi.mock('@main/storage/feedDebugLog.js', () => ({
  forgetFeedDebugSession: vi.fn(),
}))

class FakeAgentSession extends EventEmitter {
  readonly start = vi.fn(async (): Promise<void> => {
    this.emit('started', { projectDir: '/tmp/project' })
  })
  readonly stop = vi.fn(async (): Promise<void> => {})
  readonly write = vi.fn()
  readonly resize = vi.fn()
}

type LifecycleRecord = { area: string; name: string; ids?: { sessionId?: string }; data?: Record<string, unknown> }

function journalSpy() {
  const all: LifecycleRecord[] = []
  return {
    journal: { record: (input: LifecycleRecord) => all.push(input) },
    /** Only the lifecycle stream — the same journal carries other areas. */
    lifecycle: () => all.filter(r => r.area === SESSION_LIFECYCLE_AREA),
    names: () => all.filter(r => r.area === SESSION_LIFECYCLE_AREA).map(r => r.name),
    find: (name: string) => all.find(r => r.area === SESSION_LIFECYCLE_AREA && r.name === name),
  }
}

describe('SessionManager lifecycle journal', () => {
  beforeEach(() => {
    createSession.mockReset()
    createSession.mockImplementation(() => new FakeAgentSession())
    deliverPrompt.mockReset()
  })

  it('records the full cold-start ladder in order', async () => {
    // This ladder IS the artifact. "The agent takes minutes to start" becomes a
    // measurable claim only once every rung carries a duration, and the gap
    // between rungs is where the minutes will turn out to live.
    const { SessionManager } = await import('./sessionManager')
    const spy = journalSpy()
    const manager = new SessionManager(null, null, spy.journal as never)

    await manager.recover({ sessionId: 's1', kind: 'claude', cwd: '/tmp/project' })

    expect(spy.names()).toEqual([
      'recover.claim',
      'spawn.begin',
      // Seeded `{ ready: false, reason: 'starting' }` BEFORE the provider is
      // asked to start — pinned deliberately, because this is the *only*
      // readiness fact a never-ready session ever produces. `publishPromptGate`
      // is edge-triggered, so if the provider never reaches its composer
      // boundary nothing further is emitted and the renderer waits forever with
      // no additional signal. A ladder that ends here is the fingerprint of
      // "the agent takes minutes to start".
      'readiness.publish',
      'provider.start.begin',
      'provider.start.end',
      'recover.spawned',
    ])
    expect(spy.find('recover.claim')?.ids).toEqual({ sessionId: 's1' })
    expect(spy.find('recover.spawned')?.data).toMatchObject({
      kind: 'claude',
      disposition: 'spawned',
      lifecycle: 'live',
    })
    expect(typeof spy.find('provider.start.end')?.data?.durationMs).toBe('number')
  })

  describe('input.write — composer authorship', () => {
    // WHY these exist: the prompt gate refuses delivery while the composer holds
    // a draft, and decides that by classifying rendered characters. That can see
    // characters; it cannot see who wrote them. This event is the only record of
    // authorship, so if it stops being emitted — or starts carrying content —
    // the failure is silent in exactly the way that made #683 take a full
    // journal dig to diagnose.

    it('defaults an unlabelled write to renderer rather than inventing an origin', async () => {
      const { SessionManager } = await import('./sessionManager')
      const spy = journalSpy()
      const manager = new SessionManager(null, null, spy.journal as never)
      await manager.recover({ sessionId: 's1', kind: 'claude', cwd: '/tmp/project' })

      // A caller that does not declare an origin must get the honest bucket.
      // The alternative — guessing a specific surface — would put a fabricated
      // attribution in the one record that exists to answer "who wrote this",
      // which is worse than admitting the surfaces are merged.
      manager.write('s1', 'hello\r')

      const writes = spy.lifecycle().filter(r => r.name === 'input.write')
      expect(writes).toHaveLength(1)
      expect(writes[0]?.data).toMatchObject({ origin: 'renderer', hadSubmit: true })
    })

    it('separates the origins the write boundary already knows', async () => {
      // These three are distinguishable for free — `remote` is its own manager
      // entry point and `renderer-paste` is the existing pasteId read as the
      // signal it already is. The test pins them because the value of this
      // event is entirely in the distinctions it preserves; a refactor that
      // collapsed them back would leave the event still firing and still
      // useless.
      const { SessionManager } = await import('./sessionManager')
      const spy = journalSpy()
      const manager = new SessionManager(null, null, spy.journal as never)
      await manager.recover({ sessionId: 's1', kind: 'claude', cwd: '/tmp/project' })

      manager.write('s1', 'from-phone\r', 'remote')
      manager.write('s1', 'pasted-text\r', 'renderer-paste')

      const origins = spy.lifecycle()
        .filter(r => r.name === 'input.write')
        .map(r => (r.data as { origin?: string }).origin)
      expect(origins).toEqual(['remote', 'renderer-paste'])
    })

    it('records a write it is about to make, not one it has confirmed', async () => {
      // Ordering is the assertion. node-pty's write is not transactional, so a
      // throw does not prove zero bytes reached the child. Recording after the
      // crossing would drop exactly the half-failed writes most likely to
      // orphan a prompt — the case this event exists to explain. A thrown write
      // must still leave a record.
      const { SessionManager } = await import('./sessionManager')
      const spy = journalSpy()
      const manager = new SessionManager(null, null, spy.journal as never)
      await manager.recover({ sessionId: 's1', kind: 'claude', cwd: '/tmp/project' })

      const entry = (manager as never as {
        sessions: Map<string, { session: { write: (d: string) => void } }>
      }).sessions.get('s1')
      expect(entry).toBeDefined()
      entry!.session.write = () => { throw new Error('pty gone') }

      expect(() => manager.write('s1', 'lost\r')).toThrow('pty gone')

      const writes = spy.lifecycle().filter(r => r.name === 'input.write')
      expect(writes).toHaveLength(1)
      expect(writes[0]?.data).toMatchObject({ origin: 'renderer', bytes: 5 })
    })

    it('never journals what was typed', async () => {
      // The safety boundary. Counts answer "who wrote, and when", which is the
      // question; the text would make a diagnostic into a privacy problem and
      // add nothing. Asserted against the WHOLE record, because a future field
      // carrying content would otherwise pass every other test here.
      const { SessionManager } = await import('./sessionManager')
      const spy = journalSpy()
      const manager = new SessionManager(null, null, spy.journal as never)
      await manager.recover({ sessionId: 's1', kind: 'claude', cwd: '/tmp/project' })

      manager.write('s1', 'my secret api key is sk-abc123\r')

      const write = spy.lifecycle().find(r => r.name === 'input.write')
      expect(write).toBeDefined()
      expect(JSON.stringify(write)).not.toContain('secret')
      expect(JSON.stringify(write)).not.toContain('sk-abc123')
      expect(write?.data).toMatchObject({ bytes: 31 })
    })

    it('coalesces keystroke traffic instead of one event per write', async () => {
      // A raw terminal view sends one write per keystroke. Without coalescing
      // this event would bury the journal it exists to inform — and the journal
      // is bounded, so it would also evict the gate.eval records needed to
      // correlate against.
      const { SessionManager } = await import('./sessionManager')
      const spy = journalSpy()
      const manager = new SessionManager(null, null, spy.journal as never)
      await manager.recover({ sessionId: 's1', kind: 'claude', cwd: '/tmp/project' })

      for (const ch of 'typing') manager.write('s1', ch)

      expect(spy.lifecycle().filter(r => r.name === 'input.write')).toHaveLength(0)

      manager.write('s1', '\r')

      // Two events, not one, and deliberately so: the six keystrokes collapse
      // into a single "someone typed here" record, and the submit gets its own
      // because it is the boundary between "text is accumulating" and "the
      // composer should now be empty" — the exact transition needed to
      // reconstruct why a composer is occupied later.
      const flushed = spy.lifecycle().filter(r => r.name === 'input.write')
      expect(flushed).toHaveLength(2)
      expect(flushed[0]?.data).toMatchObject({ writes: 6, bytes: 6, hadSubmit: false })
      expect(flushed[1]?.data).toMatchObject({ writes: 1, hadSubmit: true })
    })
  })

  it('records hasResumeId on the claim so cold resume is separable from a fresh pane', async () => {
    const { SessionManager } = await import('./sessionManager')
    const spy = journalSpy()
    const manager = new SessionManager(null, null, spy.journal as never)

    await manager.recover({
      sessionId: 's1',
      kind: 'claude',
      cwd: '/tmp/project',
      resumeSessionId: 'provider-history',
    })

    expect(spy.find('recover.claim')?.data).toMatchObject({ hasResumeId: true })
  })

  it('records adoption with the adopted backend readiness, not just the disposition', async () => {
    // #596's entire root cause was that callers could not tell an adopted live
    // agent from a freshly spawned one. Recording readiness AT adoption is what
    // lets the Stage 4 catalog separate "adopted a busy healthy agent" from
    // "adopted a wedged one".
    const { SessionManager } = await import('./sessionManager')
    const spy = journalSpy()
    const manager = new SessionManager(null, null, spy.journal as never)

    await manager.recover({ sessionId: 's1', kind: 'claude', cwd: '/tmp/project' })
    await manager.recover({ sessionId: 's1', kind: 'claude', cwd: '/tmp/project/.' })

    const adopted = spy.find('recover.adopted')
    expect(adopted?.data).toMatchObject({ disposition: 'adopted', lifecycle: 'live' })
    expect(adopted?.data).toHaveProperty('ready')
    expect(createSession).toHaveBeenCalledTimes(1)
  })

  it('records an ownership conflict with the reason that produced it', async () => {
    const { SessionManager } = await import('./sessionManager')
    const spy = journalSpy()
    const manager = new SessionManager(null, null, spy.journal as never)

    await manager.recover({ sessionId: 's1', kind: 'claude', cwd: '/tmp/project' })
    const conflict = await manager.recover({ sessionId: 's1', kind: 'codex', cwd: '/tmp/project' })

    expect(conflict).toMatchObject({ ok: false, code: 'ownership-conflict' })
    expect(spy.find('recover.conflict')?.data).toMatchObject({
      code: 'ownership-conflict',
      reason: 'live-entry-mismatch',
    })
  })

  it('classifies a delivery rejection against an id main has never owned', async () => {
    // The reported failure: "Cannot deliver prompt: <id> is not a live agent
    // session". `never-owned` means the renderer invented or resurrected an id —
    // a persistence/ownership defect.
    const { SessionManager } = await import('./sessionManager')
    const spy = journalSpy()
    const manager = new SessionManager(null, null, spy.journal as never)

    const result = await manager.deliverPromptToAgent('ghost-id', 'hello')

    expect(result).toMatchObject({ ok: false, code: 'not-ready', stage: 'before-write' })
    expect(spy.find('delivery.reject')?.data).toMatchObject({
      code: 'not-ready',
      registryHit: false,
      reason: 'never-owned',
    })
  })

  it('distinguishes a delivery rejection for a session main owned and lost', async () => {
    // Same user-visible message, completely different defect: main DID own this
    // id, so a lifecycle teardown was not observed by the renderer — an
    // event-delivery bug rather than an id-provenance bug. These two shapes are
    // byte-identical to the user and were indistinguishable in logs until now.
    const { SessionManager } = await import('./sessionManager')
    const spy = journalSpy()
    const manager = new SessionManager(null, null, spy.journal as never)

    await manager.recover({ sessionId: 's1', kind: 'claude', cwd: '/tmp/project' })
    await manager.kill('s1')
    await manager.deliverPromptToAgent('s1', 'hello')

    expect(spy.find('delivery.reject')?.data).toMatchObject({
      registryHit: false,
      reason: 'entry-lost-after-owned',
    })
  })

  it('classifies kill by what it actually terminated', async () => {
    const { SessionManager } = await import('./sessionManager')
    const spy = journalSpy()
    const manager = new SessionManager(null, null, spy.journal as never)

    await manager.recover({ sessionId: 's1', kind: 'claude', cwd: '/tmp/project' })
    await manager.kill('s1')
    await manager.kill('never-existed')

    const kills = spy.lifecycle().filter(r => r.name === 'kill.request')
    expect(kills.map(k => k.data?.cause)).toEqual(['live-entry', 'no-owner'])
  })

  it('records every published readiness transition with its monotonic revision', async () => {
    const { SessionManager } = await import('./sessionManager')
    const spy = journalSpy()
    const session = new FakeAgentSession()
    createSession.mockImplementation(() => session)
    const manager = new SessionManager(null, null, spy.journal as never)

    await manager.recover({ sessionId: 's1', kind: 'claude', cwd: '/tmp/project' })
    session.emit('input-readiness', { ready: true, reason: 'ready' })

    const publishes = spy.lifecycle().filter(r => r.name === 'readiness.publish')
    expect(publishes.length).toBeGreaterThanOrEqual(2)
    expect(publishes[0].data).toMatchObject({ ready: false, reason: 'starting' })
    expect(publishes.at(-1)?.data).toMatchObject({ ready: true, reason: 'ready' })
    // Revisions are the ordering key every consumer uses to reject a stale seed.
    // A non-monotonic sequence here would mean the recorded stream cannot be
    // trusted to reconstruct what the renderer actually saw.
    const revisions = publishes.map(p => p.data?.revision as number)
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b))
  })

  it('records the rich gate verdict that input-readiness collapses away', async () => {
    // publishPromptGate reduces its verdict to 'ready' | 'provider-not-ready'
    // before it reaches main, so "replaying history", "the composer never
    // painted" and "a human has a draft in the box" are indistinguishable in
    // every log we have today. They are three different problems.
    const { SessionManager } = await import('./sessionManager')
    const spy = journalSpy()
    const session = new FakeAgentSession()
    createSession.mockImplementation(() => session)
    const manager = new SessionManager(null, null, spy.journal as never)

    await manager.recover({ sessionId: 's1', kind: 'claude', cwd: '/tmp/project' })
    session.emit('prompt-gate', { kind: 'warming', reason: 'composer-unpainted' })

    const evals = spy.lifecycle().filter(r => r.name === 'gate.eval')
    expect(evals).toHaveLength(1)
    expect(evals[0].data).toMatchObject({
      gate: 'warming',
      reason: 'composer-unpainted',
      elapsedMs: 0,
    })
  })

  it('records a change of WHAT a gate is blocked on', async () => {
    // Regression test for a real defect found in review. The dedupe originally
    // compared gate kind + reason, but `blocked` states carry no `reason` — they
    // carry `condition`. Every blocked state therefore looked identical, so
    // trust-dialog → permission-prompt was silently dropped and its `since`
    // never reset. That is the one event whose stated purpose is recording what
    // a gate is blocked on.
    const { SessionManager } = await import('./sessionManager')
    const spy = journalSpy()
    const session = new FakeAgentSession()
    createSession.mockImplementation(() => session)
    const manager = new SessionManager(null, null, spy.journal as never)

    await manager.recover({ sessionId: 's1', kind: 'claude', cwd: '/tmp/project' })
    session.emit('prompt-gate', { kind: 'blocked', condition: 'trust-dialog', resolvable: true })
    session.emit('prompt-gate', { kind: 'blocked', condition: 'permission-prompt', resolvable: true })

    const evals = spy.lifecycle().filter(r => r.name === 'gate.eval')
    expect(evals.map(e => e.data?.conditionKind)).toEqual(['trust-dialog', 'permission-prompt'])
  })

  it('records what a blocked gate is blocked on', async () => {
    const { SessionManager } = await import('./sessionManager')
    const spy = journalSpy()
    const session = new FakeAgentSession()
    createSession.mockImplementation(() => session)
    const manager = new SessionManager(null, null, spy.journal as never)

    await manager.recover({ sessionId: 's1', kind: 'claude', cwd: '/tmp/project' })
    session.emit('prompt-gate', { kind: 'blocked', condition: 'trust-dialog', resolvable: true })

    expect(spy.lifecycle().find(r => r.name === 'gate.eval')?.data).toMatchObject({
      gate: 'blocked',
      conditionKind: 'trust-dialog',
      resolvable: true,
    })
  })

  it('re-samples a stalled gate so the stall has a measured duration', async () => {
    // A single "not ready" event is nearly worthless — that is the normal state
    // for a moment during every boot. The same verdict still holding 90 seconds
    // later is the entire bug, and nothing in the app records elapsed time in a
    // gate state.
    vi.useFakeTimers()
    try {
      const { SessionManager } = await import('./sessionManager')
      const spy = journalSpy()
      const session = new FakeAgentSession()
      createSession.mockImplementation(() => session)
      const manager = new SessionManager(null, null, spy.journal as never)

      await manager.recover({ sessionId: 's1', kind: 'claude', cwd: '/tmp/project' })
      session.emit('prompt-gate', { kind: 'warming', reason: 'composer-unpainted' })
      await vi.advanceTimersByTimeAsync(11_000)

      const samples = spy.lifecycle()
        .filter(r => r.name === 'gate.eval')
        .filter(r => (r.data?.elapsedMs as number) > 0)
      expect(samples.length).toBeGreaterThanOrEqual(2)
      expect(samples.at(-1)?.data).toMatchObject({
        gate: 'warming',
        reason: 'composer-unpainted',
      })
      expect(samples.at(-1)?.data?.elapsedMs as number).toBeGreaterThanOrEqual(10_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops sampling once nothing is stalled, so an idle workspace writes nothing', async () => {
    vi.useFakeTimers()
    try {
      const { SessionManager } = await import('./sessionManager')
      const spy = journalSpy()
      const session = new FakeAgentSession()
      createSession.mockImplementation(() => session)
      const manager = new SessionManager(null, null, spy.journal as never)

      await manager.recover({ sessionId: 's1', kind: 'claude', cwd: '/tmp/project' })
      session.emit('prompt-gate', { kind: 'warming', reason: 'replay-pending' })
      session.emit('prompt-gate', { kind: 'ready' })
      await vi.advanceTimersByTimeAsync(30_000)

      const samples = spy.lifecycle()
        .filter(r => r.name === 'gate.eval')
        .filter(r => (r.data?.elapsedMs as number) > 0)
      expect(samples).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits nothing when constructed without a journal', async () => {
    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()

    await expect(
      manager.recover({ sessionId: 's1', kind: 'claude', cwd: '/tmp/project' }),
    ).resolves.toMatchObject({ ok: true })
  })
})
