import { describe, expect, it } from 'vitest'

import {
  CODEX_TRANSCRIPT_OBSERVATION_EVENT_NAMES,
  isCodexRendererTranscriptObservationEventName,
  isCodexTranscriptObservationEventName,
  isSessionLifecycleEventName,
  pickCodexTranscriptObservationCorrelationIds,
  pickCodexTranscriptObservationData,
  pickLifecycleCorrelationIds,
  pickLifecycleData,
} from './events.js'

describe('Codex transcript lifecycle contract', () => {
  it('keeps the export vocabulary closed and inside the lifecycle vocabulary', () => {
    for (const name of CODEX_TRANSCRIPT_OBSERVATION_EVENT_NAMES) {
      expect(isCodexTranscriptObservationEventName(name), name).toBe(true)
      expect(isSessionLifecycleEventName(name), name).toBe(true)
    }
    expect(isCodexTranscriptObservationEventName('delivery.reject')).toBe(false)
    expect(isCodexTranscriptObservationEventName('transcript.raw-prompt')).toBe(false)
    expect(isCodexRendererTranscriptObservationEventName('submit.surface')).toBe(true)
    expect(isCodexRendererTranscriptObservationEventName('provider.request')).toBe(false)
  })

  it('allows only producer-observed relations on each event', () => {
    const submissionId = 'a94119d9-c55f-430c-acb9-336c533f68be'
    expect(pickCodexTranscriptObservationCorrelationIds('submit.begin', {
      sessionRunId: 'd00b4e7c-c146-436d-8d3b-fee3a3a5b572',
      submissionId,
      proxyRequestId: 'req-7',
      semanticTurnId: 'resp-9',
      rolloutEntryId: '16777234:991882:21',
      providerWindowFingerprint: 'a'.repeat(64),
    })).toEqual({
      sessionRunId: 'd00b4e7c-c146-436d-8d3b-fee3a3a5b572',
      submissionId,
    })

    expect(pickCodexTranscriptObservationCorrelationIds('submit.reconcile', {
      submissionId,
      renderCandidateId: `queued:${submissionId}`,
      fileGenerationId: '16777234:991882',
      rolloutEntryId: '16777234:991882:21',
    }, { entryByteOffset: 21 })).toEqual({
      submissionId,
      renderCandidateId: `queued:${submissionId}`,
      fileGenerationId: '16777234:991882',
      rolloutEntryId: '16777234:991882:21',
    })
  })

  it('drops contradictory composite relations instead of preserving either claim', () => {
    expect(pickCodexTranscriptObservationCorrelationIds('submit.reconcile', {
      submissionId: 'a94119d9-c55f-430c-acb9-336c533f68be',
      renderCandidateId: 'queued:b94119d9-c55f-430c-acb9-336c533f68be',
      fileGenerationId: '16777234:991882',
      rolloutEntryId: '16777234:991883:22',
    }, { entryByteOffset: 21 })).toBeUndefined()

    expect(pickCodexTranscriptObservationCorrelationIds('provider.request', {
      proxyRequestId: 'req-7',
      providerWindowGenerationId: '0',
    })).toEqual({ proxyRequestId: 'req-7' })
  })

  it('retains separate real identifier shapes without inventing a universal join', () => {
    expect(pickLifecycleCorrelationIds({
      sessionRunId: 'd00b4e7c-c146-436d-8d3b-fee3a3a5b572',
      submissionId: 'a94119d9-c55f-430c-acb9-336c533f68be',
      proxyRequestId: 'req-7',
      proxyFlowId: 'proxy-4',
      semanticTurnId: 'rollout-1788120000000',
      rolloutEntryId: '16777234:991882:21',
      fileGenerationId: '16777234:991882',
      renderCandidateId: 'optimistic-submission:a94119d9-c55f-430c-acb9-336c533f68be',
      candidateFingerprint: 'f'.repeat(64),
      providerWindowFingerprint: 'a'.repeat(64),
      providerWindowGenerationId: '0',
      providerSessionMetaFingerprint: 'a'.repeat(64),
    })).toEqual({
      sessionRunId: 'd00b4e7c-c146-436d-8d3b-fee3a3a5b572',
      submissionId: 'a94119d9-c55f-430c-acb9-336c533f68be',
      proxyRequestId: 'req-7',
      proxyFlowId: 'proxy-4',
      semanticTurnId: 'rollout-1788120000000',
      rolloutEntryId: '16777234:991882:21',
      fileGenerationId: '16777234:991882',
      renderCandidateId: 'optimistic-submission:a94119d9-c55f-430c-acb9-336c533f68be',
      candidateFingerprint: 'f'.repeat(64),
      providerWindowFingerprint: 'a'.repeat(64),
      providerWindowGenerationId: '0',
      providerSessionMetaFingerprint: 'a'.repeat(64),
    })
  })

  it('drops unknown, prose-shaped, nested, and mutated identifiers', () => {
    expect(pickLifecycleCorrelationIds({
      submissionId: 'this is prompt prose',
      proxyRequestId: 'req/../../raw',
      semanticTurnId: { nested: 'turn-1' },
      promptFingerprint: 'secret-but-opaque',
      sessionId: 'contradictory-pane',
      candidateFingerprint: 'x'.repeat(201),
      providerWindowFingerprint: 'my-secret-prompt-is-this',
      providerSessionMetaFingerprint: 'not-a-provider-uuid-hash',
      proxyFlowId: 'proxy-9',
    })).toEqual({ proxyFlowId: 'proxy-9' })
  })

  it('accepts observed provider turn shapes without accepting prefixed prose', () => {
    expect(pickLifecycleCorrelationIds({
      semanticTurnId: '01a053a8-0611-7711-9ca3-f69f130764ab',
    })).toEqual({
      semanticTurnId: '01a053a8-0611-7711-9ca3-f69f130764ab',
    })
    expect(pickLifecycleCorrelationIds({
      semanticTurnId: 'resp_0123456789abcdef0123456789abcdef',
    })).toEqual({
      semanticTurnId: 'resp_0123456789abcdef0123456789abcdef',
    })
    expect(pickLifecycleCorrelationIds({
      semanticTurnId: 'resp-my-secret-prompt',
    })).toBeUndefined()
  })

  it('keeps transcript observations flat and content-safe', () => {
    expect(pickLifecycleData({
      surface: 'queue',
      queueReason: 'live-current-turn',
      changed: true,
      matchedBy: 'committed-observation',
      entryOrdinal: 21,
      entryCount: 0,
      totalEntries: 23,
      queueCount: 1,
      bytes: 347,
      deliveryInFlight: false,
      decision: 'hold',
      runDisposition: 'stale',
      attached: false,
      tailing: false,
      prompt: 'must never persist',
      raw: { nested: 'must never persist' },
    })).toEqual({
      surface: 'queue',
      queueReason: 'live-current-turn',
      changed: true,
      matchedBy: 'committed-observation',
      entryOrdinal: 21,
      entryCount: 0,
      totalEntries: 23,
      queueCount: 1,
      bytes: 347,
      deliveryInFlight: false,
      decision: 'hold',
      runDisposition: 'stale',
      attached: false,
      tailing: false,
    })
  })

  it('rejects prompt prose hidden inside an approved observation field', () => {
    expect(pickCodexTranscriptObservationData('transcript.attachment', {
      decision: 'hold',
      reason: 'the full private prompt could otherwise hide here',
      attached: false,
      candidateCount: 2,
    })).toEqual({
      decision: 'hold',
      attached: false,
      candidateCount: 2,
    })
  })

  it('closes the session-run relationship vocabulary in exported observations', () => {
    expect(pickCodexTranscriptObservationData('submit.release', {
      cause: 'session-exit',
      runDisposition: 'stale',
    })).toEqual({
      runDisposition: 'stale',
      cause: 'session-exit',
    })
    expect(pickCodexTranscriptObservationData('submit.release', {
      runDisposition: 'renderer says this was probably old',
    })).toBeUndefined()
  })

  it('rejects impossible null, fractional, and unsafe discrete facts', () => {
    // WHY this contract is stricter than the broad lifecycle journal: these
    // rows are exported as chronology evidence. A fractional ordinal or a
    // count that JavaScript cannot represent exactly would make the saved
    // evidence internally contradictory even though it contains no prompt.
    expect(pickCodexTranscriptObservationData('transcript.snapshot', {
      entryCount: 2.5,
      totalEntries: Number.MAX_SAFE_INTEGER + 1,
      queueCount: -1,
      status: null,
      runDisposition: null,
    })).toBeUndefined()

    expect(pickCodexTranscriptObservationData('submit.result', {
      provider: null,
      ok: null,
      durationMs: 12.5,
    })).toEqual({ durationMs: 12.5 })
  })
})
