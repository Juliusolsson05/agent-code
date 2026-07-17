import { withEditorReadError } from '@renderer/features/editor/lib/bufferOps'
import type { EditorFileBuffer } from '@renderer/features/editor/types'

/**
 * Preserve the last in-memory copy when an attached path stops being a regular
 * file.
 *
 * WHY a plain read error is insufficient: a previously clean buffer still has
 * `dirty:false`, so close/unload guards would otherwise treat it as disposable
 * even though its source file vanished. Mapping only missing/non-file errors to
 * the structured deleted conflict reuses the editor's existing Recreate and
 * dirty-close paths without misclassifying permission/transient failures.
 */
export function withAiWorkspaceReadError(
  buffer: EditorFileBuffer,
  error: string,
): EditorFileBuffer {
  return withEditorReadError(buffer, error)
}
