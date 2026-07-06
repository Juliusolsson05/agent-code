import { describe, expect, it } from 'vitest'

import { createUnknownRegistry, shapePathsOf } from '@renderer/rendering/model/unknowns'

const NOW = 1_700_000_000_000

describe('unknown-behavior registry (plan §3, #115 redaction)', () => {
  it('identical sightings dedupe into one finding with a count — floods stay readable', () => {
    const reg = createUnknownRegistry()
    const payload = { type: 'mystery_event', data: { foo: 1 } }
    for (let i = 0; i < 50; i++) {
      reg.record({
        provider: 'codex', sourcePlane: 'semantic', eventType: 'mystery_event',
        payload, disposition: 'queued_for_implementation', nowMs: NOW + i,
      })
    }
    const list = reg.list()
    expect(list).toHaveLength(1)
    expect(list[0].seenCount).toBe(50)
    expect(list[0].firstSeenAt).toBe(NOW)
  })

  it('stores shape paths + hash, NEVER the payload; preview hard-capped', () => {
    const reg = createUnknownRegistry()
    const secretText = 'the entire user prompt which must not leak'.repeat(10)
    const finding = reg.record({
      provider: 'claude', sourcePlane: 'committed', eventType: 'weird_row',
      payload: { message: { content: secretText } },
      redactedPreview: secretText,
      disposition: 'hidden_unowned', nowMs: NOW,
    })
    expect(JSON.stringify(finding)).not.toContain('must not leak"')
    expect(finding.redactedPreview!.length).toBeLessThanOrEqual(80)
    expect(finding.shapePaths).toContain('message.content')
  })

  it('auth-looking KEY NAMES are redacted from shape paths — a second belt', () => {
    const paths = shapePathsOf({ headers: { Authorization: 'Bearer x', 'x-api-key': 'k' }, ok: 1 })
    expect(paths).toContain('headers.Authorization=<redacted-key>')
    expect(paths).toContain('headers.x-api-key=<redacted-key>')
    expect(paths.join()).not.toContain('Bearer')
  })

  it('different payload shapes are different findings', () => {
    const reg = createUnknownRegistry()
    reg.record({ provider: 'opencode', sourcePlane: 'semantic', eventType: 'e', payload: { a: 1 }, disposition: 'hidden_unowned', nowMs: NOW })
    reg.record({ provider: 'opencode', sourcePlane: 'semantic', eventType: 'e', payload: { b: 2 }, disposition: 'hidden_unowned', nowMs: NOW })
    expect(reg.list()).toHaveLength(2)
  })
})
