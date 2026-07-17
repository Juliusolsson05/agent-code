import type { AiWorkspaceFileEntry, AiWorkspaceRecord } from '@mcp/shared/aiWorkspaceTypes'

import { releaseEditorModelOwner } from '@renderer/features/editor/lib/editorModelRegistry'
import { hasRecoverableBufferChanges } from '@renderer/features/editor/lib/bufferOps'
import type { EditorFileBuffer } from '@renderer/features/editor/types'

export type CachedAiWorkspaceSurface = {
  workspace: AiWorkspaceRecord | null
  error: string | null
  fileOrder: string[]
  openFiles: Record<string, EditorFileBuffer>
  activeFilePath: string | null
  entriesById: Record<string, AiWorkspaceFileEntry>
}

// Unsaved text must outlive transient Settings/Reader takeovers and switches
// between curated workspaces, but must never be serialized implicitly. A
// module-lifetime cache provides that runtime durability without creating a
// second disk persistence path for source contents. Keep this registry outside
// the UI module so teardown guards and destructive commands can inspect it
// without importing the entire Monaco-backed editor surface.
export const aiWorkspaceSurfaceCache = new Map<string, CachedAiWorkspaceSurface>()
const MAX_CLEAN_CACHED_SURFACES = 12

export function cacheAiWorkspaceSurface(
  workspaceId: string,
  surface: CachedAiWorkspaceSurface,
): void {
  // Map insertion order is our runtime LRU. Reinsert on every committed use so
  // a user can switch among active review sets without a stale creation order
  // evicting the workspace they just visited.
  aiWorkspaceSurfaceCache.delete(workspaceId)
  aiWorkspaceSurfaceCache.set(workspaceId, surface)
  if (aiWorkspaceSurfaceCache.size <= MAX_CLEAN_CACHED_SURFACES) return

  for (const [candidateId, candidate] of aiWorkspaceSurfaceCache) {
    if (candidateId === workspaceId) continue
    // Dirty buffers are promises to the user, not cache entries. The clean
    // cap may temporarily be exceeded when many workspaces contain unsaved
    // edits; preserving text is categorically more important than the bound.
    if (Object.values(candidate.openFiles).some(hasRecoverableBufferChanges)) continue
    for (const buffer of Object.values(candidate.openFiles)) {
      releaseEditorModelOwner(buffer.generation)
    }
    aiWorkspaceSurfaceCache.delete(candidateId)
    if (aiWorkspaceSurfaceCache.size <= MAX_CLEAN_CACHED_SURFACES) break
  }
}

export function hasDirtyAiWorkspaceBuffers(): boolean {
  for (const surface of aiWorkspaceSurfaceCache.values()) {
    if (Object.values(surface.openFiles).some(hasRecoverableBufferChanges)) return true
  }
  return false
}

export function dirtyAiWorkspacePaths(workspaceId: string): string[] {
  const surface = aiWorkspaceSurfaceCache.get(workspaceId)
  if (!surface) return []
  return Object.values(surface.openFiles)
    .filter(hasRecoverableBufferChanges)
    .map(buffer => buffer.absolutePath)
}
