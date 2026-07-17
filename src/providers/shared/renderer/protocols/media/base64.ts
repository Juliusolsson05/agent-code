const MAX_IMAGE_PREVIEW_BYTES = 8 * 1024 * 1024
const MAX_AUDIO_PREVIEW_BYTES = 8 * 1024 * 1024

const SAFE_IMAGE_MIME_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
])

const SAFE_AUDIO_MIME_TYPES = new Set([
  'audio/aac',
  'audio/flac',
  'audio/m4a',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
])

export type Base64MediaKind = 'image' | 'audio'

export type Base64MediaPreview = {
  kind: Base64MediaKind
  mimeType: string
  data: string
  encodedChars: number
  estimatedBytes: number
}

function estimatedDecodedBytes(encodedChars: number): number {
  // WHY an estimate instead of trimming padding and decoding: admission runs
  // while the disclosure is closed. The conservative upper bound avoids an
  // O(n) validation/decoding pass over multi-megabyte provider output merely
  // to decide whether a preview button may exist.
  return Math.ceil(encodedChars * 3 / 4)
}

export function parseBase64MediaPreview(
  kind: Base64MediaKind,
  mimeType: unknown,
  data: unknown,
): Base64MediaPreview | null {
  if (typeof mimeType !== 'string' || typeof data !== 'string' || data.length === 0) {
    return null
  }

  const normalizedMimeType = mimeType.trim().toLowerCase()
  const safeMimeTypes = kind === 'image' ? SAFE_IMAGE_MIME_TYPES : SAFE_AUDIO_MIME_TYPES
  if (!safeMimeTypes.has(normalizedMimeType)) return null

  const estimatedBytes = estimatedDecodedBytes(data.length)
  const maxBytes = kind === 'image' ? MAX_IMAGE_PREVIEW_BYTES : MAX_AUDIO_PREVIEW_BYTES
  if (estimatedBytes > maxBytes) return null

  return {
    kind,
    mimeType: normalizedMimeType,
    data,
    encodedChars: data.length,
    estimatedBytes,
  }
}

export function base64MediaDataUrl(model: Base64MediaPreview): string {
  // WHY construction is kept separate from admission: concatenating a data
  // URL copies the complete base64 payload. Callers invoke this only after an
  // explicit disclosure opens, so a collapsed feed containing many images
  // retains the transcript bytes once rather than duplicating them into DOM
  // attributes before the user asks to see any preview.
  return `data:${model.mimeType};base64,${model.data}`
}
