import { normalizeCodeLanguage } from '@shared/code/language'
import type { EditorFileBuffer } from '@renderer/features/editor/types'

// Pure buffer-lifecycle transitions shared by the Global Editor store
// (zustand, per-cwd) and the AI Workspace editor (component-local state).
//
// WHY only the TRANSITIONS are shared and not a whole store: the two
// surfaces intentionally keep different state containers and IO adapters
// (root-contained editor-fs vs the AI Workspace registry — see the
// trust-boundary WHY on EditorWorkbench). What they kept re-implementing,
// and drifting on (dirty derivation, error/conflict clearing rules), is
// the buffer math itself. Pure functions capture exactly that overlap:
// same inputs, same buffer out, no opinion about where the buffer lives.

export function makeBuffer(params: {
  /** Surface-local identity: cwd-relative path (Global Editor) or
   *  entryId (AI Workspace). */
  path: string
  absolutePath: string
  /** Basename used for language detection — passed separately because
   *  the AI Workspace `path` is an opaque entryId, not a file name. */
  fileName: string
  text: string
  mtimeMs: number | null
  selection?: { line: number; column: number } | null
}): EditorFileBuffer {
  return {
    path: params.path,
    absolutePath: params.absolutePath,
    language: normalizeCodeLanguage(null, params.fileName),
    savedText: params.text,
    currentText: params.text,
    dirty: false,
    loading: false,
    error: null,
    conflict: false,
    mtimeMs: params.mtimeMs,
    selection: params.selection ?? null,
  }
}

/** The user typed. Dirty derives from text comparison (not a set flag) so
 *  undoing back to the saved text un-dirties the tab. Errors clear —
 *  they're tied to the previous save attempt, and the next ⌘S re-runs
 *  the authoritative mtime check in main; a pinned stale "file changed
 *  on disk" after the user kept editing misleads more than it helps. */
export function withTextUpdate(buffer: EditorFileBuffer, text: string): EditorFileBuffer {
  return {
    ...buffer,
    currentText: text,
    dirty: text !== buffer.savedText,
    error: null,
    conflict: false,
  }
}

/** A write (or reload-from-disk) succeeded: `text` is now both the saved
 *  and current content. */
export function withSaved(
  buffer: EditorFileBuffer,
  text: string,
  mtimeMs: number,
): EditorFileBuffer {
  return {
    ...buffer,
    savedText: text,
    currentText: text,
    dirty: false,
    mtimeMs,
    error: null,
    conflict: false,
  }
}

export function withError(
  buffer: EditorFileBuffer,
  error: string | null,
  conflict = false,
): EditorFileBuffer {
  return { ...buffer, error, conflict }
}
