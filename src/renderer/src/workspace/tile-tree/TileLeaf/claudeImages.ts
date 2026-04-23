import type { ClaudeDraftImage } from '@renderer/workspace/workspaceState'

// Helpers for turning pasted / dropped / clipboard images into the
// `ClaudeDraftImage` payload shape the workspace runtime stores.
//
// Three ingress paths:
//   1. Files in `clipboardData.items` (the common case for a
//      copy-image-from-app → paste flow).
//   2. An `<img src="data:image/...">` embedded in an HTML fragment
//      (some browsers copy web images as HTML + data URL rather than
//      a real File).
//   3. `navigator.clipboard.read()` for cases (1) and (2) when
//      `clipboardData` came up empty (Electron picks a clipboard
//      representation per OS and some combinations only surface
//      through the async API).
//
// All three return the same `ClaudeDraftImage[]` so the caller can
// concat + dedupe uniformly.

export const MAX_CLAUDE_IMAGE_BYTES = 5 * 1024 * 1024

export const SUPPORTED_CLAUDE_IMAGE_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

export const SUPPORTED_CLAUDE_IMAGE_FORMATS_TEXT = 'PNG, JPEG, GIF, WebP'

export function isSupportedClaudeImageMediaType(mediaType: string): boolean {
  return SUPPORTED_CLAUDE_IMAGE_MEDIA_TYPES.has(mediaType.toLowerCase())
}

export function exceedsClaudeImageSizeLimit(image: ClaudeDraftImage): boolean {
  return estimateBase64DecodedBytes(image.base64Data) > MAX_CLAUDE_IMAGE_BYTES
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('failed to read file'))
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('file reader returned non-string result'))
    }
    reader.readAsDataURL(file)
  })
}

export function parseDataUrl(dataUrl: string): { mediaType: string; base64Data: string } {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl)
  if (!match) {
    throw new Error('unsupported image data url')
  }
  return {
    mediaType: match[1] ?? 'image/png',
    base64Data: match[2] ?? '',
  }
}

// Rough byte-count estimate: 4 base64 chars encode 3 bytes, minus
// 1 byte per `=` pad char. We only use this for the size-limit gate,
// so approximate is fine — a 5 MB cap enforced at ±16 bytes is still
// effectively a 5 MB cap.
export function estimateBase64DecodedBytes(base64Data: string): number {
  const normalized = base64Data.trim()
  if (normalized.length === 0) return 0
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0
  return Math.floor((normalized.length * 3) / 4) - padding
}

export function parseImagesFromHtml(html: string): ClaudeDraftImage[] {
  if (!html.trim()) return []
  // Some browsers copy web images as an HTML fragment containing an
  // embedded data URL rather than exposing a File in clipboardData.
  // We only parse this into a detached Document and read `img.src` —
  // the HTML is never injected into the live DOM.
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const images: ClaudeDraftImage[] = []
  for (const img of Array.from(doc.images)) {
    const src = img.getAttribute('src')?.trim() ?? ''
    if (!src.startsWith('data:image/')) continue
    try {
      const { mediaType, base64Data } = parseDataUrl(src)
      images.push({
        id: crypto.randomUUID(),
        mediaType,
        base64Data,
        previewUrl: src,
        filename: img.getAttribute('alt')?.trim() || 'Pasted image',
      })
    } catch {
      // Ignore malformed HTML image sources and keep scanning.
    }
  }
  return images
}

export async function filesToDraftImages(files: File[]): Promise<ClaudeDraftImage[]> {
  return Promise.all(
    files.map(async file => {
      const previewUrl = await fileToDataUrl(file)
      const { mediaType, base64Data } = parseDataUrl(previewUrl)
      return {
        id: crypto.randomUUID(),
        mediaType,
        base64Data,
        previewUrl,
        filename: file.name || 'Pasted image',
      } satisfies ClaudeDraftImage
    }),
  )
}

export async function readImagesFromClipboard(): Promise<ClaudeDraftImage[]> {
  if (!navigator.clipboard?.read) return []
  const items = await navigator.clipboard.read()
  const images: ClaudeDraftImage[] = []
  for (const item of items) {
    const imageType = item.types.find(type => type.startsWith('image/'))
    if (!imageType) continue
    const blob = await item.getType(imageType)
    const previewUrl = await fileToDataUrl(new File([blob], 'Pasted image', { type: imageType }))
    const { mediaType, base64Data } = parseDataUrl(previewUrl)
    images.push({
      id: crypto.randomUUID(),
      mediaType,
      base64Data,
      previewUrl,
      filename: 'Pasted image',
    })
  }
  return images
}
