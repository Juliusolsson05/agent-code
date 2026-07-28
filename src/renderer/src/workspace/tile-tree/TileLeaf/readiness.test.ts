import { describe, expect, it } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'

import { formatReadinessElapsed, resolveReadinessText } from './readiness'

describe('resolveReadinessText', () => {
  it('does not present a deliberately parked backend as starting', () => {
    expect(resolveReadinessText({
      ...emptyRuntime(),
      processStatus: 'idle',
      inputReady: false,
      transcriptStatus: 'ready',
    })).toBeNull()
  })

  it('shows startup feedback only while a backend is actually becoming ready', () => {
    expect(resolveReadinessText({
      ...emptyRuntime(),
      processStatus: 'spawning',
      inputReady: false,
      transcriptStatus: 'ready',
    })).toBe('starting agent')

    expect(resolveReadinessText({
      ...emptyRuntime(),
      processStatus: 'started',
      inputReady: false,
      transcriptStatus: 'ready',
    })).toBe('starting agent')
  })

  it('keeps terminal backend failures visible', () => {
    expect(resolveReadinessText({
      ...emptyRuntime(),
      processStatus: 'failed',
      processError: 'provider binary missing',
      inputReady: false,
      transcriptStatus: 'ready',
    })).toBe('provider binary missing')

    expect(resolveReadinessText({
      ...emptyRuntime(),
      processStatus: 'exited',
      exited: 7,
      inputReady: false,
      transcriptStatus: 'ready',
    })).toBe('agent exited (code 7)')
  })

  it('names the readiness reason instead of a generic starting label', () => {
    // Before this, EVERY non-ready state rendered 'starting agent'. A wedged
    // pane and a healthy one looked identical, which is a large part of why
    // "the agent takes minutes to start" was never actionable.
    expect(resolveReadinessText({
      ...emptyRuntime(),
      processStatus: 'started',
      inputReady: false,
      transcriptStatus: 'ready',
      inputReadinessReason: 'replaying-history',
    })).toBe('replaying transcript')

    expect(resolveReadinessText({
      ...emptyRuntime(),
      processStatus: 'started',
      inputReady: false,
      transcriptStatus: 'ready',
      inputReadinessReason: 'provider-not-ready',
    })).toBe('waiting for agent')
  })

  it('appends elapsed time, which is what separates wedged from normal', () => {
    const since = 1_000_000
    expect(resolveReadinessText({
      ...emptyRuntime(),
      processStatus: 'started',
      inputReady: false,
      transcriptStatus: 'ready',
      inputReadinessReason: 'provider-not-ready',
      inputReadinessChangedAt: since,
    }, since + 94_000)).toBe('waiting for agent · 1m 34s')
  })

  it('omits elapsed when the caller supplies no clock', () => {
    // Non-ticking callers must not be forced to mount a timer.
    expect(resolveReadinessText({
      ...emptyRuntime(),
      processStatus: 'started',
      inputReady: false,
      transcriptStatus: 'ready',
      inputReadinessReason: 'provider-not-ready',
      inputReadinessChangedAt: 1_000_000,
    })).toBe('waiting for agent')
  })

  it('falls back to a generic label rather than rendering an unknown raw token', () => {
    // A newer build could send a reason this one has never heard of; the status
    // line must not turn into a protocol dump.
    expect(resolveReadinessText({
      ...emptyRuntime(),
      processStatus: 'started',
      inputReady: false,
      transcriptStatus: 'ready',
      inputReadinessReason: 'something-a-newer-build-sends' as never,
    })).toBe('starting agent')
  })

  it('appends the typed recovery code to a failed pane', () => {
    // 'ownership-conflict' (another backend owns this id) and 'start-failed'
    // (the provider would not launch) need completely different responses from
    // the user, and both previously rendered as one undifferentiated string.
    expect(resolveReadinessText({
      ...emptyRuntime(),
      processStatus: 'failed',
      processError: 'Session failed to start. Check provider setup and retry.',
      recoveryFailureCode: 'ownership-conflict',
      inputReady: false,
      transcriptStatus: 'ready',
    })).toBe('Session failed to start. Check provider setup and retry. (ownership-conflict)')
  })

  it('times a stuck transcript load — the #283 signature', () => {
    const since = 5_000
    expect(resolveReadinessText({
      ...emptyRuntime(),
      transcriptStatus: 'loading',
      inputReadinessChangedAt: since,
    }, since + 30_000)).toBe('loading transcript · 30s')
  })
})

describe('formatReadinessElapsed', () => {
  it('suppresses sub-second noise', () => {
    expect(formatReadinessElapsed(400)).toBe('')
  })

  it('reads seconds below a minute and minutes above it', () => {
    // The number exists to answer "is this normal or wedged?" — 3s vs 4s never
    // changes that answer, 3s vs 4m always does.
    expect(formatReadinessElapsed(3_000)).toBe('3s')
    expect(formatReadinessElapsed(59_000)).toBe('59s')
    expect(formatReadinessElapsed(60_000)).toBe('1m')
    expect(formatReadinessElapsed(3_723_000)).toBe('62m 3s')
  })
})
