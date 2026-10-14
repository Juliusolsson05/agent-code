import { describe, expect, it } from 'vitest'

import { inboundFrames, recordingFor } from 'hermes-headless/testing/corpus'

import { conditionRecord } from './hermesSession'

// The RECORDED secret request from Hermes v0.22.0 (S6, the hh-secret skill).
// The wire carries no deadline; the card counts down to Hermes' fixed 300 s
// wait, but only for a request this pane saw arrive (r3 A5).
const frame = inboundFrames(recordingFor('S6', 'v0.22.0')).find((entry) => entry.method === 'secret')!
const request = { id: String(frame.id), method: 'secret' as const, params: frame.params as Record<string, unknown> }

describe('secret / sudo card countdown', () => {
  it('counts down to Hermes\' wait for a request seen live', () => {
    const record = conditionRecord({ ...request, replayed: false }, 0, 1_000)
    expect((record.state as { expiresAt: number }).expiresAt).toBe(301_000)
  })

  it('shows no countdown for a request replayed after a reconnect (its start is unknown)', () => {
    const record = conditionRecord({ ...request, replayed: true }, 0, 1_000)
    expect((record.state as { expiresAt: number | null }).expiresAt).toBeNull()
  })
})
