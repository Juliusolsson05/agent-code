import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SESSION_LIFECYCLE_AREA } from '@shared/lifecycle/events.js'

// One shared emitter stands in for ipcMain so the handler can be driven
// synchronously. `ipcMain.on` is the only surface this module uses.
const bus = new EventEmitter()
vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
      bus.on(channel, payload => listener({}, payload))
    },
  },
}))

type Recorded = {
  area: string
  name: string
  ids?: {
    sessionId?: string
    sessionRunId?: string
    submissionId?: string
    proxyRequestId?: string
    renderCandidateId?: string
  }
  data?: Record<string, unknown>
}

function send(payload: unknown): void {
  bus.emit('session:lifecycle-report', payload)
}

describe('registerLifecycleIpc', () => {
  let records: Recorded[]

  beforeEach(async () => {
    // Frozen clock so the token bucket is deterministic: with real time a
    // synchronous storm never refills, and the suppression summary — which only
    // emits once a token is available again — could never be observed.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-28T00:00:00Z'))
    bus.removeAllListeners()
    records = []
    const { registerLifecycleIpc } = await import('./lifecycle')
    registerLifecycleIpc({ record: (r: Recorded) => records.push(r) } as never)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const lifecycle = (): Recorded[] => records.filter(r => r.area === SESSION_LIFECYCLE_AREA)

  const exhaustLifecycleBucket = (): void => {
    for (let i = 0; i < 300; i += 1) {
      send({ name: 'wake.request', sessionId: 'bucket-filler' })
    }
  }

  const refillLifecycleBucket = (): void => {
    vi.setSystemTime(new Date('2026-07-28T00:00:01Z'))
  }

  it('accepts a known event name and forwards its session id', () => {
    send({ name: 'wake.request', sessionId: 's1', data: { caller: 'tile-leaf.send' } })

    expect(lifecycle()).toHaveLength(1)
    expect(lifecycle()[0]).toMatchObject({
      name: 'wake.request',
      ids: { sessionId: 's1' },
      data: { caller: 'tile-leaf.send' },
    })
  })

  it('drops an event name outside the closed vocabulary', () => {
    // A renderer from a different build must not be able to widen the
    // vocabulary at runtime — the closed set is what keeps the stream readable.
    send({ name: 'totally.made.up', sessionId: 's1' })
    send({ name: 'wake.request', sessionId: 's1' })

    expect(lifecycle().map(r => r.name)).toEqual(['wake.request'])
  })

  it('ignores malformed payloads without throwing', () => {
    // IPC is a runtime trust boundary and a renderer mid-freeze is exactly the
    // sender most likely to be malformed.
    expect(() => {
      send(null)
      send('a string')
      send(42)
      send({})
      send({ name: 123 })
    }).not.toThrow()
    expect(lifecycle()).toHaveLength(0)
  })

  it('strips payload keys outside the allowlist', () => {
    send({
      name: 'submit.result',
      sessionId: 's1',
      data: { ok: false, prompt: 'secret user text', stack: 'nope' },
    })

    expect(lifecycle()[0].data).toEqual({ ok: false })
  })

  it('accepts closed correlation ids and rejects prose or unknown joins on legacy rows', () => {
    send({
      name: 'submit.begin',
      sessionId: 's1',
      data: { provider: 'opencode' },
      correlationIds: {
        sessionRunId: 'fcb908cc-bf0e-4c5b-a4c6-d64d32c30c37',
        submissionId: '2659692b-81d9-49d0-b896-c98574dd6d2f',
        proxyRequestId: 'not an identifier because it contains prose',
        promptId: 'an-invented-universal-join',
        sessionId: 'different-session',
      },
    })

    expect(lifecycle()[0]).toMatchObject({
      name: 'submit.begin',
      ids: {
        sessionId: 's1',
        sessionRunId: 'fcb908cc-bf0e-4c5b-a4c6-d64d32c30c37',
        submissionId: '2659692b-81d9-49d0-b896-c98574dd6d2f',
      },
      data: { provider: 'opencode' },
    })
    expect(lifecycle()[0].ids).not.toHaveProperty('proxyRequestId')
    expect(lifecycle()[0].ids).not.toHaveProperty('promptId')
  })

  it('preserves stale renderer run identity without joining the successor recording', async () => {
    bus.removeAllListeners()
    records = []
    const recordCodexTranscriptObservation = vi.fn()
    let activeCodexKind: 'codex' | null = 'codex'
    const codexSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const getSessionKind = vi.fn((sessionId: string) =>
      sessionId === codexSessionId ? activeCodexKind : 'claude')
    const staleRunId = '11111111-1111-4111-8111-111111111111'
    const currentRunId = '22222222-2222-4222-8222-222222222222'
    let activeRunId: string | null = currentRunId
    const getSessionRunId = vi.fn(() => activeRunId)
    const getCodexSessionRunState = vi.fn((_sessionId: string, runId: string) =>
      runId === activeRunId
        ? 'live'
        : runId === staleRunId || (activeRunId === null && runId === currentRunId)
          ? 'retired'
          : null)
    const { registerLifecycleIpc } = await import('./lifecycle')
    registerLifecycleIpc(
      { record: (r: Recorded) => records.push(r) } as never,
      { getSessionKind, getSessionRunId, getCodexSessionRunState } as never,
      { recordCodexTranscriptObservation } as never,
    )

    send({
      name: 'submit.surface',
      sessionId: codexSessionId,
      data: { surface: 'render-selected' },
      correlationIds: {
        sessionRunId: staleRunId,
        submissionId: 'sub-1',
      },
    })
    send({
      name: 'submit.surface',
      sessionId: 'claude-pane',
      correlationIds: { submissionId: 'sub-2' },
    })

    expect(lifecycle()[0]?.ids).toMatchObject({
      sessionId: codexSessionId,
      sessionRunId: staleRunId,
      submissionId: 'sub-1',
    })
    expect(lifecycle()[0]?.data).toMatchObject({ runDisposition: 'stale' })
    expect(recordCodexTranscriptObservation).not.toHaveBeenCalled()

    send({
      name: 'submit.surface',
      sessionId: codexSessionId,
      data: { surface: 'render-selected' },
      correlationIds: {
        sessionRunId: currentRunId,
        submissionId: 'sub-2',
      },
    })

    expect(lifecycle()[1]?.ids).toMatchObject({
      sessionRunId: currentRunId,
      submissionId: 'sub-2',
    })
    expect(lifecycle()[1]?.data).toMatchObject({ runDisposition: 'current' })
    expect(recordCodexTranscriptObservation).toHaveBeenCalledTimes(1)
    expect(recordCodexTranscriptObservation).toHaveBeenCalledWith(
      codexSessionId,
      currentRunId,
      expect.objectContaining({
        schemaVersion: 1,
        name: 'submit.surface',
        ids: expect.objectContaining({ sessionRunId: currentRunId }),
        data: expect.objectContaining({ runDisposition: 'current' }),
      }),
    )

    // Exit removes the registry entry before renderer effects and durable debug
    // flushing necessarily finish. The old run stays attributable in the app
    // journal but cannot be appended to a recorder selected only by pane id.
    activeRunId = null
    activeCodexKind = null
    send({
      name: 'submit.release',
      sessionId: codexSessionId,
      data: { cause: 'session-exit' },
      correlationIds: {
        sessionRunId: currentRunId,
        submissionId: 'sub-2',
      },
    })

    expect(lifecycle()[2]?.ids).toMatchObject({ sessionRunId: currentRunId })
    expect(lifecycle()[2]?.data).toMatchObject({
      cause: 'session-exit',
      runDisposition: 'retired-or-unknown',
    })
    expect(recordCodexTranscriptObservation).toHaveBeenCalledTimes(1)
  })

  it('does not guess a current run for an unattributed renderer observation', async () => {
    bus.removeAllListeners()
    records = []
    const recordCodexTranscriptObservation = vi.fn()
    const { registerLifecycleIpc } = await import('./lifecycle')
    registerLifecycleIpc(
      { record: (r: Recorded) => records.push(r) } as never,
      {
        getSessionKind: () => 'codex',
        getSessionRunId: () => '33333333-3333-4333-8333-333333333333',
        getCodexSessionRunState: () => null,
      } as never,
      { recordCodexTranscriptObservation } as never,
    )

    send({
      name: 'submit.release',
      sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      data: { cause: 'session-exit' },
      correlationIds: { submissionId: 'sub-3' },
    })

    expect(lifecycle()[0]?.ids).toEqual({
      sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      submissionId: 'sub-3',
    })
    expect(lifecycle()[0]?.data).toMatchObject({ runDisposition: 'missing' })
    expect(recordCodexTranscriptObservation).not.toHaveBeenCalled()
  })

  it('keeps an unproven legacy run generic and strips a forged provenance verdict', async () => {
    bus.removeAllListeners()
    records = []
    const recordCodexTranscriptObservation = vi.fn()
    const sessionId = '31313131-3131-4131-8131-313131313131'
    const currentRunId = '32323232-3232-4232-8232-323232323232'
    const unknownRunId = '33333333-3333-4333-8333-333333333334'
    const { registerLifecycleIpc } = await import('./lifecycle')
    registerLifecycleIpc(
      { record: (r: Recorded) => records.push(r) } as never,
      {
        getSessionKind: () => 'codex',
        getSessionRunId: () => currentRunId,
        getCodexSessionRunState: () => null,
      } as never,
      { recordCodexTranscriptObservation } as never,
    )

    send({
      name: 'submit.begin',
      sessionId,
      data: {
        provider: 'codex',
        source: 'text-only',
        // The key is allowlisted for main's output, but renderer input must not
        // be able to self-declare the exact manager proof it failed above.
        runDisposition: 'current',
      },
      correlationIds: {
        sessionRunId: unknownRunId,
        submissionId: '34343434-3434-4434-8434-343434343434',
      },
    })

    expect(lifecycle()).toEqual([
      expect.objectContaining({
        name: 'submit.begin',
        ids: expect.objectContaining({ sessionId, sessionRunId: unknownRunId }),
        data: { provider: 'codex', source: 'text-only' },
      }),
    ])
    expect(lifecycle()[0]?.data).not.toHaveProperty('runDisposition')
    expect(recordCodexTranscriptObservation).not.toHaveBeenCalled()
  })

  it('drops Codex-named observations from another provider entirely', async () => {
    bus.removeAllListeners()
    records = []
    const recordCodexTranscriptObservation = vi.fn()
    const { registerLifecycleIpc } = await import('./lifecycle')
    registerLifecycleIpc(
      { record: (r: Recorded) => records.push(r) } as never,
      {
        getSessionKind: () => 'opencode',
        getSessionRunId: () => '44444444-4444-4444-8444-444444444444',
        getCodexSessionRunState: () => null,
      } as never,
      { recordCodexTranscriptObservation } as never,
    )

    send({
      name: 'submit.surface',
      sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      data: { surface: 'queued-strip' },
      correlationIds: {
        sessionRunId: '44444444-4444-4444-8444-444444444444',
        submissionId: '55555555-5555-4555-8555-555555555555',
      },
    })

    expect(lifecycle()).toEqual([])
    expect(recordCodexTranscriptObservation).not.toHaveBeenCalled()
  })

  it('rejects provider- and main-owned observation names from renderer IPC', async () => {
    bus.removeAllListeners()
    records = []
    const sessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const sessionRunId = '66666666-6666-4666-8666-666666666666'
    const submissionId = '77777777-7777-4777-8777-777777777777'
    const providerFingerprint = 'a'.repeat(64)
    const candidateFingerprint = 'b'.repeat(64)
    const { registerLifecycleIpc } = await import('./lifecycle')
    registerLifecycleIpc(
      { record: (r: Recorded) => records.push(r) } as never,
      {
        getSessionKind: () => 'codex',
        getSessionRunId: () => sessionRunId,
        getCodexSessionRunState: () => 'live',
      } as never,
    )

    const forbiddenReports = [
      {
        name: 'submit.write',
        data: { phase: 'body', bytes: 81, ok: true },
        correlationIds: { sessionRunId, submissionId },
      },
      {
        name: 'provider.request',
        data: { phase: 'created', source: 'proxy', cause: 'request-created' },
        correlationIds: {
          sessionRunId,
          proxyRequestId: 'req-1',
          proxyFlowId: 'proxy-1',
          providerWindowFingerprint: providerFingerprint,
          providerWindowGenerationId: '1',
        },
      },
      {
        name: 'semantic.turn',
        data: { phase: 'started', source: 'proxy' },
        correlationIds: {
          sessionRunId,
          proxyRequestId: 'req-1',
          proxyFlowId: 'proxy-1',
          semanticTurnId: 'resp_0123456789abcdef0123456789abcdef',
        },
      },
      {
        name: 'transcript.attachment',
        data: { decision: 'accept', attached: true, candidateCount: 1 },
        correlationIds: {
          sessionRunId,
          candidateFingerprint,
          providerSessionMetaFingerprint: providerFingerprint,
        },
      },
      {
        name: 'transcript.candidate',
        data: { phase: 'pre-lease', matched: true },
        correlationIds: {
          sessionRunId,
          candidateFingerprint,
          providerSessionMetaFingerprint: providerFingerprint,
        },
      },
      {
        name: 'transcript.entry',
        data: { source: 'session-meta', entryOrdinal: 0, attached: true },
        correlationIds: {
          sessionRunId,
          fileGenerationId: '1:2',
          rolloutEntryId: '1:2:0',
          providerSessionMetaFingerprint: providerFingerprint,
        },
      },
      {
        name: 'transcript.observation-gap',
        data: { phase: 'opened', runDisposition: 'current' },
        correlationIds: { sessionRunId },
      },
    ]

    for (const report of forbiddenReports) send({ ...report, sessionId })

    expect(lifecycle()).toEqual([])
  })

  it('removes valid-shape identifiers that the renderer event could not observe', async () => {
    bus.removeAllListeners()
    records = []
    const sessionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    const sessionRunId = '88888888-8888-4888-8888-888888888888'
    const submissionId = '99999999-9999-4999-8999-999999999999'
    const { registerLifecycleIpc } = await import('./lifecycle')
    registerLifecycleIpc(
      { record: (r: Recorded) => records.push(r) } as never,
      {
        getSessionKind: () => 'codex',
        getSessionRunId: () => sessionRunId,
        getCodexSessionRunState: () => 'live',
      } as never,
    )

    send({
      name: 'submit.surface',
      sessionId,
      data: { surface: 'queued-strip' },
      correlationIds: {
        sessionRunId,
        submissionId,
        renderCandidateId: `queued:${submissionId}`,
        // Both values pass their individual shape validators. Keeping them on
        // a renderer surface fact would nevertheless invent a proxy relation.
        proxyRequestId: 'req-9',
        semanticTurnId: 'resp_0123456789abcdef0123456789abcdef',
      },
    })

    expect(lifecycle()[0]?.ids).toEqual({
      sessionId,
      sessionRunId,
      submissionId,
      renderCandidateId: `queued:${submissionId}`,
    })
  })

  it('opens and closes an exact current-run observation gap around admitted evidence', async () => {
    bus.removeAllListeners()
    records = []
    const recordCodexTranscriptObservation = vi.fn()
    const sessionId = '12121212-1212-4212-8212-121212121212'
    const sessionRunId = '13131313-1313-4313-8313-131313131313'
    const submissionId = '14141414-1414-4414-8414-141414141414'
    const { registerLifecycleIpc } = await import('./lifecycle')
    registerLifecycleIpc(
      { record: (r: Recorded) => records.push(r) } as never,
      {
        getSessionKind: () => 'codex',
        getSessionRunId: () => sessionRunId,
        getCodexSessionRunState: () => 'live',
      } as never,
      { recordCodexTranscriptObservation } as never,
    )
    const report = {
      name: 'submit.surface',
      sessionId,
      data: { surface: 'queued-strip' },
      correlationIds: { sessionRunId, submissionId },
    }

    exhaustLifecycleBucket()
    send(report)
    send(report)

    expect(lifecycle().filter(r => r.name === 'transcript.observation-gap')).toEqual([
      expect.objectContaining({
        ids: { sessionId, sessionRunId },
        data: { phase: 'opened', runDisposition: 'current' },
      }),
    ])

    refillLifecycleBucket()
    send(report)

    expect(lifecycle().slice(-3)).toEqual([
      expect.objectContaining({
        name: 'report.suppressed',
        data: expect.objectContaining({ suppressed: 2 }),
      }),
      expect.objectContaining({
        name: 'transcript.observation-gap',
        ids: { sessionId, sessionRunId },
        data: { phase: 'closed', suppressed: 2, runDisposition: 'current' },
      }),
      expect.objectContaining({ name: 'submit.surface', ids: expect.objectContaining({ sessionRunId }) }),
    ])
    expect(recordCodexTranscriptObservation.mock.calls.map(call => call[2].name)).toEqual([
      'transcript.observation-gap',
      'transcript.observation-gap',
      'submit.surface',
    ])
  })

  it('does not let run B close run A, while a delayed admitted A row closes only A as stale', async () => {
    bus.removeAllListeners()
    records = []
    const recordCodexTranscriptObservation = vi.fn()
    const sessionId = '15151515-1515-4515-8515-151515151515'
    const runA = '16161616-1616-4616-8616-161616161616'
    const runB = '17171717-1717-4717-8717-171717171717'
    let activeRunId = runA
    const { registerLifecycleIpc } = await import('./lifecycle')
    registerLifecycleIpc(
      { record: (r: Recorded) => records.push(r) } as never,
      {
        getSessionKind: () => 'codex',
        getSessionRunId: () => activeRunId,
        getCodexSessionRunState: (_sessionId: string, runId: string) =>
          runId === activeRunId ? 'live' : runId === runA ? 'retired' : null,
      } as never,
      { recordCodexTranscriptObservation } as never,
    )
    const reportFor = (sessionRunId: string) => ({
      name: 'submit.surface',
      sessionId,
      data: { surface: 'queued-strip' },
      correlationIds: {
        sessionRunId,
        submissionId: sessionRunId === runA
          ? '18181818-1818-4818-8818-181818181818'
          : '19191919-1919-4919-8919-191919191919',
      },
    })

    exhaustLifecycleBucket()
    send(reportFor(runA))
    activeRunId = runB
    refillLifecycleBucket()
    send(reportFor(runB))

    // An admitted successor row is not a generic "the stream recovered" edge.
    // Only the exact {pane, reported run} key is allowed to close its own loss.
    expect(lifecycle().filter(r =>
      r.name === 'transcript.observation-gap' && r.data?.phase === 'closed')).toEqual([])

    send(reportFor(runA))

    const closed = lifecycle().filter(r =>
      r.name === 'transcript.observation-gap' && r.data?.phase === 'closed')
    expect(closed).toEqual([
      expect.objectContaining({
        ids: { sessionId, sessionRunId: runA },
        data: { phase: 'closed', suppressed: 1, runDisposition: 'stale' },
      }),
    ])
    const recorderNames = recordCodexTranscriptObservation.mock.calls.map(call => call[2].name)
    expect(recorderNames).toEqual(['transcript.observation-gap', 'submit.surface'])
  })

  it('lets an exact retired run close its own gap without touching a live recorder', async () => {
    bus.removeAllListeners()
    records = []
    const recordCodexTranscriptObservation = vi.fn()
    const sessionId = '20202020-2020-4020-8020-202020202020'
    const sessionRunId = '21212121-2121-4121-8121-212121212121'
    let retired = false
    const { registerLifecycleIpc } = await import('./lifecycle')
    registerLifecycleIpc(
      { record: (r: Recorded) => records.push(r) } as never,
      {
        getSessionKind: () => retired ? null : 'codex',
        getSessionRunId: () => retired ? null : sessionRunId,
        getCodexSessionRunState: (_sessionId: string, runId: string) =>
          runId === sessionRunId ? (retired ? 'retired' : 'live') : null,
      } as never,
      { recordCodexTranscriptObservation } as never,
    )
    const report = {
      name: 'submit.release',
      sessionId,
      data: { cause: 'session-exit' },
      correlationIds: {
        sessionRunId,
        submissionId: '22222222-2222-4222-8222-222222222222',
      },
    }

    exhaustLifecycleBucket()
    send(report)
    retired = true
    refillLifecycleBucket()
    send(report)

    expect(lifecycle().filter(r =>
      r.name === 'transcript.observation-gap' && r.data?.phase === 'closed')).toEqual([
      expect.objectContaining({
        ids: { sessionId, sessionRunId },
        data: { phase: 'closed', suppressed: 1, runDisposition: 'retired-or-unknown' },
      }),
    ])
    // Only the opening happened while this exact run was live. Neither the
    // retired close nor its following row may leak into a successor recorder.
    expect(recordCodexTranscriptObservation).toHaveBeenCalledTimes(1)
  })

  it('keeps missing-run loss in a separate bucket and never substitutes the current run', async () => {
    bus.removeAllListeners()
    records = []
    const recordCodexTranscriptObservation = vi.fn()
    const sessionId = '23232323-2323-4323-8323-232323232323'
    const currentRunId = '24242424-2424-4424-8424-242424242424'
    const { registerLifecycleIpc } = await import('./lifecycle')
    registerLifecycleIpc(
      { record: (r: Recorded) => records.push(r) } as never,
      {
        getSessionKind: () => 'codex',
        getSessionRunId: () => currentRunId,
        getCodexSessionRunState: () => null,
      } as never,
      { recordCodexTranscriptObservation } as never,
    )
    const report = {
      name: 'submit.release',
      sessionId,
      data: { cause: 'session-exit' },
      correlationIds: { submissionId: '25252525-2525-4525-8525-252525252525' },
    }

    exhaustLifecycleBucket()
    send(report)
    send(report)
    refillLifecycleBucket()
    send(report)

    const gaps = lifecycle().filter(r => r.name === 'transcript.observation-gap')
    expect(gaps).toEqual([
      expect.objectContaining({
        ids: { sessionId },
        data: { phase: 'opened', runDisposition: 'missing' },
      }),
      expect.objectContaining({
        ids: { sessionId },
        data: { phase: 'closed', suppressed: 2, runDisposition: 'missing' },
      }),
    ])
    expect(gaps.every(gap => !gap.ids?.sessionRunId)).toBe(true)
    expect(recordCodexTranscriptObservation).not.toHaveBeenCalled()
  })

  it('fails closed for non-UUID panes and unknown retired run pairs', async () => {
    bus.removeAllListeners()
    records = []
    const knownRetiredRun = '26262626-2626-4626-8626-262626262626'
    const unknownRun = '27272727-2727-4727-8727-272727272727'
    const { registerLifecycleIpc } = await import('./lifecycle')
    registerLifecycleIpc(
      { record: (r: Recorded) => records.push(r) } as never,
      {
        getSessionKind: () => null,
        getSessionRunId: () => null,
        getCodexSessionRunState: (_sessionId: string, runId: string) =>
          runId === knownRetiredRun ? 'retired' : null,
      } as never,
    )

    send({
      name: 'submit.surface',
      sessionId: 'a-user-prompt-shaped-pane',
      data: { surface: 'queued-strip' },
      correlationIds: { sessionRunId: knownRetiredRun },
    })
    send({
      name: 'submit.surface',
      sessionId: '28282828-2828-4828-8828-282828282828',
      data: { surface: 'queued-strip' },
      correlationIds: { sessionRunId: unknownRun },
    })

    expect(lifecycle()).toEqual([])
  })

  it('bounds distinct retired-pair gap openings without evicting admitted evidence', async () => {
    bus.removeAllListeners()
    records = []
    const sessionId = '29292929-2929-4929-8929-292929292929'
    const retiredRun = (index: number): string =>
      `30303030-3030-4030-8030-${index.toString().padStart(12, '0')}`
    const { registerLifecycleIpc } = await import('./lifecycle')
    registerLifecycleIpc(
      { record: (r: Recorded) => records.push(r) } as never,
      {
        getSessionKind: () => null,
        getSessionRunId: () => null,
        // The real manager admits only pairs present in its bounded ledger. This
        // test deliberately supplies the maximum abusive-but-proven history to
        // verify the gap exception still cannot become an unlimited writer.
        getCodexSessionRunState: () => 'retired',
      } as never,
    )

    exhaustLifecycleBucket()
    for (let i = 0; i < 1_025; i += 1) {
      send({
        name: 'submit.surface',
        sessionId,
        data: { surface: 'queued-strip' },
        correlationIds: { sessionRunId: retiredRun(i) },
      })
    }

    const opened = lifecycle().filter(r =>
      r.name === 'transcript.observation-gap' && r.data?.phase === 'opened')
    expect(opened).toHaveLength(1_024)

    refillLifecycleBucket()
    send({
      name: 'submit.surface',
      sessionId,
      data: { surface: 'queued-strip' },
      correlationIds: { sessionRunId: retiredRun(0) },
    })

    expect(lifecycle().filter(r =>
      r.name === 'transcript.observation-gap' && r.data?.phase === 'closed')).toEqual([
      expect.objectContaining({
        ids: expect.objectContaining({ sessionRunId: retiredRun(0) }),
        data: expect.objectContaining({ phase: 'closed', suppressed: 1 }),
      }),
    ])
    expect(lifecycle().find(r => r.name === 'report.suppressed')?.data).toMatchObject({
      suppressed: 1_025,
    })
  })

  it('latches source incompleteness after 1,024 already-closed gaps exhaust tracking', async () => {
    bus.removeAllListeners()
    records = []
    const sessionId = '31313131-3131-4131-8131-313131313131'
    const sessionRunId = '32323232-3232-4232-8232-323232323232'
    const { registerLifecycleIpc } = await import('./lifecycle')
    const diagnostics = registerLifecycleIpc(
      { record: (r: Recorded) => records.push(r) } as never,
      {
        getSessionKind: () => 'codex',
        getSessionRunId: () => sessionRunId,
        getCodexSessionRunState: () => 'live',
      } as never,
    )
    const report = {
      name: 'submit.release',
      sessionId,
      data: { cause: 'session-exit' },
      correlationIds: {
        sessionRunId,
        submissionId: '33333333-3333-4333-8333-333333333333',
      },
    }

    exhaustLifecycleBucket()
    for (let cycle = 0; cycle < 1_024; cycle += 1) {
      send(report)
      // 10 ms refills exactly one token at 100/s. The admitted report closes
      // this cycle's gap and consumes that one token, so the next iteration can
      // immediately open another gap without generating 100k filler rows.
      vi.setSystemTime(new Date('2026-07-28T00:00:00Z').getTime() + ((cycle + 1) * 10))
      send(report)
    }
    expect(diagnostics.getCodexTranscriptObservationCompletenessSnapshot()).toEqual({
      gapTrackingCapped: false,
    })

    // All prior keys are closed and the map is empty. The lifetime bypass cap
    // must still be reflected in bundle metadata when this next dropped row can
    // no longer receive its own opened marker.
    send(report)
    expect(diagnostics.getCodexTranscriptObservationCompletenessSnapshot()).toEqual({
      gapTrackingCapped: true,
    })
    expect(lifecycle().filter(row =>
      row.name === 'transcript.observation-gap' && row.data?.phase === 'opened',
    )).toHaveLength(1_024)
  })

  it('preserves the legacy provider-neutral submit rows without projecting them as Codex', async () => {
    bus.removeAllListeners()
    records = []
    const recordCodexTranscriptObservation = vi.fn()
    const { registerLifecycleIpc } = await import('./lifecycle')
    registerLifecycleIpc(
      { record: (r: Recorded) => records.push(r) } as never,
      {
        getSessionKind: () => 'opencode',
        getSessionRunId: () => '44444444-4444-4444-8444-444444444444',
        getCodexSessionRunState: () => null,
      } as never,
      { recordCodexTranscriptObservation } as never,
    )

    send({
      name: 'submit.begin',
      sessionId: 'opencode-pane',
      data: { provider: 'opencode', source: 'text-only' },
      correlationIds: {
        sessionRunId: '44444444-4444-4444-8444-444444444444',
        submissionId: '55555555-5555-4555-8555-555555555555',
      },
    })

    expect(lifecycle()).toEqual([
      expect.objectContaining({
        name: 'submit.begin',
        ids: expect.objectContaining({
          sessionRunId: '44444444-4444-4444-8444-444444444444',
          submissionId: '55555555-5555-4555-8555-555555555555',
        }),
        data: expect.objectContaining({ provider: 'opencode', source: 'text-only' }),
      }),
    ])
    expect(lifecycle()[0]?.data).not.toHaveProperty('runDisposition')
    expect(recordCodexTranscriptObservation).not.toHaveBeenCalled()
  })

  it('rate-limits a storm and records the count of what it dropped', () => {
    // A remount loop or retry storm is precisely the pathological state this
    // instrumentation exists to observe. Unbounded, it would flood the journal
    // and evict the breadcrumbs explaining it.
    for (let i = 0; i < 500; i += 1) {
      send({ name: 'wake.request', sessionId: 's1', data: { caller: 'tile-leaf.send' } })
    }

    // Exactly BURST admitted while the clock is frozen; the other 200 dropped.
    expect(lifecycle()).toHaveLength(300)
    expect(lifecycle().every(r => r.name === 'wake.request')).toBe(true)

    // The drop must be RECORDED, not silent: a reader reconstructing a ladder
    // has to tell "this pane emitted nothing" from "this pane's events were
    // dropped". One second of refill admits the next report, which carries the
    // count of everything lost.
    vi.setSystemTime(new Date('2026-07-28T00:00:01Z'))
    send({ name: 'wake.request', sessionId: 's1' })

    const suppressed = lifecycle().filter(r => r.name === 'report.suppressed')
    expect(suppressed).toHaveLength(1)
    expect(suppressed[0].data).toMatchObject({ suppressed: 200, reason: 'rate-limited' })
  })

  it('truncates an unreasonably long session id rather than storing it whole', () => {
    send({ name: 'wake.request', sessionId: 'x'.repeat(5000) })

    expect((lifecycle()[0].ids?.sessionId ?? '').length).toBe(200)
  })
})
