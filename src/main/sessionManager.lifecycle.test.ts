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

type LifecycleRecord = {
  area: string
  name: string
  ids?: Record<string, string>
  data?: Record<string, unknown>
}

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

  it('keeps Codex run, proxy, semantic, attachment, and rollout-entry identities explicit', async () => {
    const { SessionManager } = await import('./sessionManager')
    const spy = journalSpy()
    const session = new FakeAgentSession()
    const recordingRows: Array<Record<string, unknown>> = []
    createSession.mockImplementation(() => session)
    const manager = new SessionManager(
      null,
      null,
      spy.journal as never,
      null,
      (_sessionId, _sessionRunId, observation) => recordingRows.push(observation),
    )
    const started: Array<{ sessionRunId?: string }> = []
    const productSemanticEvents: unknown[] = []
    const productTranscriptDiagnostics: unknown[] = []
    manager.on('started', event => started.push(event))
    manager.on('semantic-event', event => productSemanticEvents.push(event))
    manager.on('transcript-diagnostic', event => productTranscriptDiagnostics.push(event))

    const codexPaneId = '61616161-6161-4161-8161-616161616161'
    await manager.recover({ sessionId: codexPaneId, kind: 'codex', cwd: '/tmp/project' })
    session.emit('transcript-diagnostic', {
      type: 'provider-request-observation',
      observation: {
        type: 'provider_request',
        requestId: 'req-7',
        flowId: 'proxy-3',
        phase: 'created',
        cause: 'request-created',
        providerSessionFingerprint: 'aca570c74cde331b785ba5bf566981ab43bc540cc9b71e68b2056fce42c5c27b',
        providerWindowGenerationId: '0',
        subagentHeaderPresent: false,
        source: 'proxy',
      },
    })
    expect(productSemanticEvents).toEqual([])
    expect(productTranscriptDiagnostics).toEqual([])
    session.emit('semantic-event', {
      type: 'turn_started',
      requestId: 'req-7',
      flowId: 'proxy-3',
      turnId: 'resp-9',
      source: 'proxy',
    })
    session.emit('transcript-diagnostic', {
      type: 'fresh-rollout-ownership-decision',
      decision: 'accept',
      reason: 'path-leased',
      tailStarted: true,
      evidence: {
        candidateCount: 1,
        matchingCandidateCount: 1,
        candidateFingerprints: ['a'.repeat(64)],
        matchingCandidateFingerprints: ['a'.repeat(64)],
        candidateProviderSessionFingerprints: [{
          candidateFingerprint: 'a'.repeat(64),
          providerSessionMetaFingerprint: 'aca570c74cde331b785ba5bf566981ab43bc540cc9b71e68b2056fce42c5c27b',
        }],
        leasedCandidateFingerprint: 'a'.repeat(64),
      },
    })
    session.emit('jsonl-entry', {
      type: 'session_meta',
      payload: { id: '01a053a8-0611-7711-9ca3-f69f130764ab' },
    }, '/private/native/path.jsonl', {
      fileGenerationId: '16777234:991882',
      rolloutByteOffset: 21,
      providerSessionMetaFingerprint: 'aca570c74cde331b785ba5bf566981ab43bc540cc9b71e68b2056fce42c5c27b',
    })
    session.emit('jsonl-entry', {
      type: 'session_meta',
      payload: { id: 'raw-provider-id-must-not-be-hashed-by-main' },
    }, '/private/native/path.jsonl', {
      fileGenerationId: '16777234:991882',
      rolloutByteOffset: 22,
    })

    expect(started[0]?.sessionRunId).toMatch(/^[0-9a-f-]{36}$/)
    const runId = manager.getSessionRunId(codexPaneId)
    expect(runId).toBe(started[0]?.sessionRunId)
    expect(runId).not.toBeNull()
    expect(manager.getCodexSessionRunState(codexPaneId, runId!)).toBe('live')
    expect(manager.getCodexSessionRunState(
      codexPaneId,
      '99999999-9999-4999-8999-999999999999',
    )).toBeNull()
    expect(spy.find('provider.request')?.ids).toMatchObject({
      sessionId: codexPaneId,
      sessionRunId: runId,
      proxyRequestId: 'req-7',
      proxyFlowId: 'proxy-3',
      providerWindowFingerprint: 'aca570c74cde331b785ba5bf566981ab43bc540cc9b71e68b2056fce42c5c27b',
      providerWindowGenerationId: '0',
    })
    expect(spy.find('provider.request')?.data).toMatchObject({
      // False means only that the header was not observed; it is not a root
      // request classification and therefore cannot prove a parent-flow join.
      subagentHeaderPresent: false,
    })
    expect(spy.find('semantic.turn')?.ids).toMatchObject({
      proxyRequestId: 'req-7',
      proxyFlowId: 'proxy-3',
      semanticTurnId: 'resp-9',
    })
    expect(spy.find('transcript.candidate')?.ids).toMatchObject({
      candidateFingerprint: 'a'.repeat(64),
      providerSessionMetaFingerprint: 'aca570c74cde331b785ba5bf566981ab43bc540cc9b71e68b2056fce42c5c27b',
    })
    expect(spy.find('transcript.attachment')?.ids).toMatchObject({
      candidateFingerprint: 'a'.repeat(64),
    })
    expect(spy.find('transcript.entry')?.ids).toMatchObject({
      fileGenerationId: '16777234:991882',
      rolloutEntryId: '16777234:991882:21',
      providerSessionMetaFingerprint: 'aca570c74cde331b785ba5bf566981ab43bc540cc9b71e68b2056fce42c5c27b',
    })
    const transcriptEntryRows = spy.lifecycle()
      .filter(row => row.name === 'transcript.entry')
    expect(transcriptEntryRows).toHaveLength(2)
    expect(transcriptEntryRows[0]?.data).toMatchObject({
      providerSessionMetaValid: true,
    })
    expect(transcriptEntryRows[1]).toMatchObject({
      ids: {
        fileGenerationId: '16777234:991882',
        rolloutEntryId: '16777234:991882:22',
      },
      data: {
        source: 'session-meta',
        entryByteOffset: 22,
        attached: true,
        tailing: true,
        providerSessionMetaValid: false,
      },
    })
    expect(transcriptEntryRows[1]?.ids).not.toHaveProperty(
      'providerSessionMetaFingerprint',
    )
    expect(JSON.stringify(spy.lifecycle())).not.toContain('/private/native/path.jsonl')
    expect(recordingRows.map(row => row.name)).toEqual([
      'provider.request',
      'semantic.turn',
      'transcript.candidate',
      'transcript.attachment',
      'transcript.entry',
      'transcript.entry',
    ])
    await manager.kill(codexPaneId)
    // WHY retirement is exact-pair evidence: delayed post-commit observations
    // from this run remain classifiable after registry teardown, while a
    // fabricated or stale run under the same pane id receives no provenance.
    expect(manager.getCodexSessionRunState(codexPaneId, runId!)).toBe('retired')
    expect(manager.getCodexSessionRunState(
      codexPaneId,
      '99999999-9999-4999-8999-999999999999',
    )).toBeNull()
  })

  it('degrades novel provider observation enum values to explicit unknown sentinels', async () => {
    const { SessionManager } = await import('./sessionManager')
    const spy = journalSpy()
    const session = new FakeAgentSession()
    createSession.mockImplementation(() => session)
    const manager = new SessionManager(null, null, spy.journal as never)
    const sessionId = '62626262-6262-4262-8262-626262626262'

    await manager.recover({ sessionId, kind: 'codex', cwd: '/tmp/project' })
    session.emit('transcript-diagnostic', {
      type: 'provider-request-observation',
      observation: {
        type: 'provider_request',
        phase: 'future-retry-phase',
        source: 'future-transport',
        cause: 'future-terminal-cause',
      },
    })
    session.emit('semantic-event', {
      type: 'turn_started',
      source: 'future-semantic-source',
    })

    expect(spy.find('provider.request')?.data).toMatchObject({
      phase: 'unknown',
      source: 'unknown',
      cause: 'unknown',
    })
    expect(spy.find('semantic.turn')?.data).toMatchObject({
      phase: 'started',
      source: 'unknown',
    })
  })

  it('records a provider source fact before a synchronous product listener retires its run', async () => {
    const { SessionManager } = await import('./sessionManager')
    const spy = journalSpy()
    const session = new FakeAgentSession()
    createSession.mockImplementation(() => session)
    const manager = new SessionManager(null, null, spy.journal as never)
    const sessionId = '65656565-6565-4565-8565-656565656565'

    await manager.recover({ sessionId, kind: 'codex', cwd: '/tmp/project' })
    const sourceRunId = manager.getSessionRunId(sessionId)
    expect(sourceRunId).not.toBeNull()
    manager.on('semantic-event', () => {
      // EventEmitter listeners are synchronous. This recreates the exact race
      // in which a product consumer tears down A before the diagnostic code
      // following `emit()` can look up the stable pane id again.
      void manager.kill(sessionId)
    })

    session.emit('semantic-event', {
      type: 'turn_started',
      requestId: 'req-88',
      flowId: 'proxy-88',
      turnId: 'resp-88',
      source: 'proxy',
    })

    expect(spy.find('semantic.turn')?.ids).toMatchObject({
      sessionId,
      sessionRunId: sourceRunId,
      proxyRequestId: 'req-88',
    })
    expect(manager.getSessionRunId(sessionId)).toBeNull()
  })

  it('refuses a provider observation whose captured run no longer owns the pane', async () => {
    const { SessionManager } = await import('./sessionManager')
    const spy = journalSpy()
    const manager = new SessionManager(null, null, spy.journal as never)
    const sessionId = '66666666-6666-4666-8666-666666666666'

    await manager.recover({ sessionId, kind: 'codex', cwd: '/tmp/project' })
    manager.recordCodexTranscriptObservation(
      'transcript.snapshot',
      sessionId,
      { entryCount: 1 },
      undefined,
      '77777777-7777-4777-8777-777777777777',
    )

    expect(spy.lifecycle().filter(row => row.name === 'transcript.snapshot')).toEqual([])
  })

  it('records each bounded candidate edge once per Codex backend run', async () => {
    const { SessionManager } = await import('./sessionManager')
    const spy = journalSpy()
    const session = new FakeAgentSession()
    createSession.mockImplementation(() => session)
    const manager = new SessionManager(null, null, spy.journal as never)

    await manager.recover({
      sessionId: '62626262-6262-4262-8262-626262626262',
      kind: 'codex',
      cwd: '/tmp/project',
    })
    const candidateFingerprints = Array.from({ length: 40 }, (_, index) =>
      index.toString(16).padStart(64, '0'))
    const diagnostic = {
      type: 'fresh-rollout-ownership-decision',
      decision: 'ambiguous',
      reason: 'ownership-contended',
      tailStarted: false,
      evidence: {
        candidateCount: candidateFingerprints.length,
        matchingCandidateCount: 1,
        candidateFingerprints,
        matchingCandidateFingerprints: [candidateFingerprints.at(-1)!],
        candidateProviderSessionFingerprints: [{
          candidateFingerprint: candidateFingerprints.at(-1)!,
          providerSessionMetaFingerprint: 'b'.repeat(64),
        }],
        leasedCandidateFingerprint: null,
      },
    }

    // Coordinator recomputes can repeat byte-identical evidence as siblings
    // register. One repeated decision must not multiply 40 candidates into 80
    // journal rows; the attachment summary still reports what was suppressed.
    session.emit('transcript-diagnostic', diagnostic)
    session.emit('transcript-diagnostic', diagnostic)

    const candidates = spy.lifecycle().filter(row => row.name === 'transcript.candidate')
    const attachments = spy.lifecycle().filter(row => row.name === 'transcript.attachment')
    expect(candidates).toHaveLength(8)
    expect(candidates[0]).toMatchObject({
      ids: { candidateFingerprint: candidateFingerprints.at(-1) },
      data: { matched: true },
    })
    expect(candidates[0]?.ids).toMatchObject({
      providerSessionMetaFingerprint: 'b'.repeat(64),
    })
    expect(attachments.map(row => row.data?.suppressed)).toEqual([32])
  })

  it('marks candidate-ledger loss without multiplying repeated oversized decisions', async () => {
    const { SessionManager } = await import('./sessionManager')
    const spy = journalSpy()
    const session = new FakeAgentSession()
    createSession.mockImplementation(() => session)
    const manager = new SessionManager(null, null, spy.journal as never)

    await manager.recover({
      sessionId: '63636363-6363-4363-8363-636363636363',
      kind: 'codex',
      cwd: '/tmp/project',
    })
    const candidateFingerprints = Array.from({ length: 300 }, (_, index) =>
      index.toString(16).padStart(64, '0'))
    const diagnostic = {
      type: 'fresh-rollout-ownership-decision',
      decision: 'ambiguous',
      reason: 'ownership-contended',
      tailStarted: false,
      evidence: {
        candidateCount: candidateFingerprints.length,
        matchingCandidateCount: 0,
        candidateFingerprints,
        matchingCandidateFingerprints: [],
      },
    }

    session.emit('transcript-diagnostic', diagnostic)
    session.emit('transcript-diagnostic', diagnostic)

    expect(spy.lifecycle().filter(row => row.name === 'transcript.candidate')).toHaveLength(8)
    expect(spy.lifecycle().filter(row => row.name === 'transcript.attachment')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ suppressed: 292, trackingCapped: true }),
      }),
    ])
  })

  it('caps attachment transitions low enough to preserve sparse submit evidence', async () => {
    const { SessionManager } = await import('./sessionManager')
    const spy = journalSpy()
    const session = new FakeAgentSession()
    createSession.mockImplementation(() => session)
    const manager = new SessionManager(null, null, spy.journal as never)

    await manager.recover({
      sessionId: '64646464-6464-4464-8464-646464646464',
      kind: 'codex',
      cwd: '/tmp/project',
    })
    for (let index = 0; index < 20; index += 1) {
      session.emit('transcript-diagnostic', {
        type: 'fresh-rollout-ownership-decision',
        decision: index % 2 === 0 ? 'hold' : 'accept',
        reason: index % 2 === 0 ? 'awaiting-local-prompt' : 'path-leased',
        tailStarted: index % 2 !== 0,
        evidence: { candidateCount: 0, matchingCandidateCount: 0 },
      })
    }

    const attachments = spy.lifecycle().filter(row => row.name === 'transcript.attachment')
    expect(attachments).toHaveLength(9)
    expect(attachments.at(-1)?.data).toMatchObject({ trackingCapped: true })
    // Eight candidate edges plus nine attachment rows per pane leaves room for
    // submit/reconcile facts even in a 100-pane burst under the 2,000-row cap.
    expect((8 + attachments.length) * 100).toBeLessThan(2_000)
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
