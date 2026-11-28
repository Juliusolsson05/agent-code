import type { InlinePromptImage } from '@shared/types/providerConfig.js'

/** Recheck the desktop IPC payload in main. Base64 padding can change the decoded
 * size by two bytes; checking the encoded length alone accepts oversized images. */
export function validInlinePromptImages(value: unknown): value is InlinePromptImage[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 4 && Array.from(value).every(image => {
    if (!image || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mediaType)) return false
    const data = image.base64Data
    const limit = 5 * 1024 * 1024
    if (typeof data !== 'string' || !data.length || data.length % 4 || data.length > 4 * Math.ceil(limit / 3)) return false
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
    return data.length * 3 / 4 - padding <= limit && /^[A-Za-z0-9+/]+={0,2}$/.test(data)
  })
}
