import { describe, expect, it } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'

import { resolveReadinessText } from './readiness'

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
})
