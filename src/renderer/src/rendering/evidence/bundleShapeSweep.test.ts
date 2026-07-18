import { describe, expect, it } from 'vitest'

import { sweepBundleShapes } from '@renderer/rendering/evidence/bundleShapeSweep'

describe('bundle shape sweep observation scope', () => {
  it('excludes exact native content but observes known-label drift and unknown first contact', () => {
    const observations = sweepBundleShapes({
      input: {
        provider: 'claude',
        entries: [{
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'answer' },
              { type: 'thinking', thinking: 'reasoning' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'eA==' },
              },
              { type: 'text', text: 'painted text', citations: [] },
              { type: 'thinking', thinking: 'painted thought', future_signature: 'v2' },
              { type: 'image', source: { type: 'url', url: 'https://example.test/image' } },
              { type: 'future_content', payload: { value: 1 } },
              { type: 'tool_use', id: 't1', name: 'Read', input: {} },
              { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
            ],
          },
        }],
      },
    })

    expect(observations.map(observation => [observation.plane, observation.eventType])).toEqual([
      ['transcript-entry', 'text'],
      ['transcript-entry', 'thinking'],
      ['transcript-entry', 'image'],
      ['transcript-entry', 'future_content'],
      ['committed-tool-use', 'tool_use'],
      ['committed-tool-result', 'tool_result'],
    ])
    expect(observations.slice(0, 4).map(observation => observation.outcome)).toEqual([
      { kind: 'unknown', fallbackRenderId: 'shared.content-block-envelope-drift' },
      { kind: 'unknown', fallbackRenderId: 'shared.content-block-envelope-drift' },
      { kind: 'unknown', fallbackRenderId: 'shared.content-block-envelope-drift' },
      { kind: 'unknown', fallbackRenderId: 'shared.block-type-label' },
    ])
  })
})
