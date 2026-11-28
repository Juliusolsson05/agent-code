import { describe, expect, it } from 'vitest'
import { validInlinePromptImages } from './inlinePromptImages.js'

describe('inline image delivery from the composer', () => {
  it('bounds bytes and rejects malformed, sparse, external and unsupported content', () => {
    const image = { mediaType: 'image/png', base64Data: 'AQ==' }
    expect(validInlinePromptImages([image])).toBe(true)
    for (const invalid of [
      [], Array(1), [null], Array(5).fill(image),
      [{ ...image, mediaType: 'image/svg+xml' }],
      [{ ...image, base64Data: '%%%%' }], [{ ...image, base64Data: 'file:///tmp/picture' }],
      [{ ...image, base64Data: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') }],
    ]) expect(validInlinePromptImages(invalid)).toBe(false)
  })
})
