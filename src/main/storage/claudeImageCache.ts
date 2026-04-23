import { randomUUID } from 'crypto'
import { extname, join } from 'path'
import { mkdir, rm, writeFile } from 'fs/promises'
import { app } from 'electron'

// Claude image paste cache.
//
// When the user pastes an image into the Claude composer, the
// renderer ships the base64 bytes to main; main writes them to a
// cache dir and returns the absolute path. The renderer then includes
// that path in the prompt text (Claude's CLI resolves `@<path>` as an
// image attachment). Files are disposable — the whole dir is wiped on
// each app startup.
//
// Lives under Electron's temp root so platform cleanup policy (user
// manually clearing /tmp, macOS purging inactive files) handles
// anything we forget to delete. NEVER user-facing; paths are opaque.

const SUPPORTED_CLAUDE_IMAGE_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

const MAX_CLAUDE_IMAGE_BYTES = 5 * 1024 * 1024

export type SaveClaudeImageParams = {
  base64Data: string
  mediaType: string
  filename?: string
}

export type SavedClaudeImage = {
  path: string
}

function extensionForMediaType(mediaType: string, filename?: string): string {
  switch (mediaType) {
    case 'image/jpeg':
      return '.jpg'
    case 'image/gif':
      return '.gif'
    case 'image/webp':
      return '.webp'
    case 'image/png':
      return '.png'
  }
  // Fall back to the filename's own extension if the media type is
  // somehow unrecognized — safer than fabricating `.bin` which would
  // break Claude's file-type detection.
  const fromName = extname(filename ?? '').trim().toLowerCase()
  return fromName || '.png'
}

function isSupportedClaudeImageMediaType(mediaType: string): boolean {
  return SUPPORTED_CLAUDE_IMAGE_MEDIA_TYPES.has(mediaType.toLowerCase())
}

function estimateBase64DecodedBytes(base64Data: string): number {
  // Base64 encodes 3 bytes into 4 chars; trailing `=` are padding.
  // Tight estimate is enough to reject oversize uploads without
  // actually allocating the buffer first.
  const normalized = base64Data.trim()
  if (normalized.length === 0) return 0
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0
  return Math.floor((normalized.length * 3) / 4) - padding
}

function getClaudeImageCacheDir(): string {
  return join(app.getPath('temp'), 'cc-shell', 'claude-images')
}

export async function cleanupClaudeImageCacheDir(): Promise<void> {
  await rm(getClaudeImageCacheDir(), { recursive: true, force: true })
}

/**
 * Decode a renderer-submitted base64 image and write it to the cache.
 * Returns the absolute path of the written file. Throws on unsupported
 * media type or oversized payload — the renderer surfaces those to the
 * user as toast errors.
 */
export async function saveClaudeImage(
  params: SaveClaudeImageParams,
): Promise<SavedClaudeImage> {
  if (!isSupportedClaudeImageMediaType(params.mediaType)) {
    throw new Error(`unsupported Claude image media type: ${params.mediaType}`)
  }
  if (estimateBase64DecodedBytes(params.base64Data) > MAX_CLAUDE_IMAGE_BYTES) {
    throw new Error('Claude image exceeds 5 MB limit')
  }
  const cacheDir = getClaudeImageCacheDir()
  await mkdir(cacheDir, { recursive: true })
  const ext = extensionForMediaType(params.mediaType, params.filename)
  const filePath = join(cacheDir, `${randomUUID()}${ext}`)
  await writeFile(filePath, Buffer.from(params.base64Data, 'base64'))
  return { path: filePath }
}
