// Claude image-paste IPC contract.
//
// WHY shared: the renderer pastes an image, preload bridges the bytes, and
// `src/main/storage/claudeImageCache.ts` validates + writes it to the cache.
// The params/result shapes were declared in both main storage and preload;
// the `fs:saveClaudeImage` bridge even inlined the params a third time. One
// definition keeps the contract honest across all three.
//
// INVARIANT: validation (media-type allow-list, byte cap) stays in
// claudeImageCache.ts — this is types only.

export type SaveClaudeImageParams = {
  /** Raw base64 (no data: URL prefix). */
  base64Data: string
  mediaType: string
  filename?: string
}

export type SavedClaudeImage = {
  /** Absolute path of the written cache file. */
  path: string
}
