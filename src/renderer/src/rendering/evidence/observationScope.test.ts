import { describe, expect, it } from 'vitest'

import { committedBlockObservationDisposition } from './observationScope'

describe('committed content-block observation scope', () => {
  it('keeps only exact normalized text and thinking envelopes content-native', () => {
    expect(committedBlockObservationDisposition({ type: 'text', text: 'answer' }))
      .toBe('content-native')
    expect(committedBlockObservationDisposition({
      type: 'thinking',
      thinking: 'reasoning',
      signature: 'opaque',
    })).toBe('content-native')

    expect(committedBlockObservationDisposition({ type: 'text', text: 'answer', citations: [] }))
      .toBe('content-drift')
    expect(committedBlockObservationDisposition({ type: 'text', content: 'renamed' }))
      .toBe('content-drift')
    expect(committedBlockObservationDisposition({
      type: 'thinking',
      thinking: 'reasoning',
      signature: { version: 2 },
    })).toBe('content-drift')
  })

  it('accepts exact base64 image aliases but observes new or widened source schemas', () => {
    expect(committedBlockObservationDisposition({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'eA==' },
    })).toBe('content-native')
    expect(committedBlockObservationDisposition({
      type: 'image',
      source: { type: 'base64', mimeType: 'image/png', data: 'eA==' },
    })).toBe('content-native')

    expect(committedBlockObservationDisposition({
      type: 'image',
      source: { type: 'url', url: 'https://example.test/image' },
    })).toBe('content-drift')
    expect(committedBlockObservationDisposition({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'eA==', checksum: 'new' },
    })).toBe('content-drift')
    expect(committedBlockObservationDisposition({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'eA==' },
      cacheKey: 'new',
    })).toBe('content-drift')
  })
})
