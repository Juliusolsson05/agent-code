import { describe, expect, it } from 'vitest'

import { extractStreamingWriteInput } from './streamingWriteInput'

describe('extractStreamingWriteInput', () => {
  it('decodes either member order for ordinary streaming writes', () => {
    expect(extractStreamingWriteInput(
      '{"content":"first\\nsecond","file_path":"/tmp/example.ts"}',
    )).toEqual({
      filePath: '/tmp/example.ts',
      partialContent: 'first\nsecond',
    })
  })

  it('caps the live content prefix before a large write can create quadratic replay work', () => {
    const content = 'x'.repeat(64 * 1024)
    const extracted = extractStreamingWriteInput(JSON.stringify({
      file_path: '/tmp/large.txt',
      content,
    }))

    // WHY assert the structural budget, not elapsed wall time: CI timing is
    // noisy, while this exact cap proves every future delta performs at most
    // one renderer page of decoding and allocation.
    expect(extracted.filePath).toBe('/tmp/large.txt')
    expect(extracted.partialContent).toHaveLength(16 * 1024)
    expect(extracted.partialContent).toBe(content.slice(0, 16 * 1024))
  })
})
