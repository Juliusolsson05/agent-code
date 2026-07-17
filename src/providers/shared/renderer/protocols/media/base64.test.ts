import { describe, expect, it } from 'vitest'

import { base64MediaDataUrl, parseBase64MediaPreview } from './base64'

describe('base64 media preview admission', () => {
  it('admits an allowlisted image without constructing its URL during parsing', () => {
    const model = parseBase64MediaPreview('image', 'IMAGE/PNG', 'YWJj')

    expect(model).toMatchObject({
      kind: 'image',
      mimeType: 'image/png',
      encodedChars: 4,
      estimatedBytes: 3,
    })
    expect(base64MediaDataUrl(model!)).toBe('data:image/png;base64,YWJj')
  })

  it('declines active/unknown MIME types and oversized payloads', () => {
    expect(parseBase64MediaPreview('image', 'image/svg+xml', 'PHN2Zz4=')).toBeNull()
    expect(parseBase64MediaPreview('audio', 'text/html', 'PGgxPg==')).toBeNull()
    expect(parseBase64MediaPreview('image', 'image/png', 'a'.repeat(12 * 1024 * 1024))).toBeNull()
  })
})
