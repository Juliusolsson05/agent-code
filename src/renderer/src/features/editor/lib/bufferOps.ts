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

let bufferGenerationSequence = 0

/**
 * A deleted clean buffer is not "saved" in the only sense that matters to a
 * close decision: its in-memory text is now the last recoverable copy. Treating
 * recoverability as `dirty` alone made the tab dot look truthful while Close,
 * Explorer delete, and window teardown could still discard that copy without a
 * decision. Keep this predicate beside the buffer transitions so every surface
 * shares the same lifecycle invariant.
 */
export function hasRecoverableBufferChanges(buffer: EditorFileBuffer): boolean {
  return buffer.dirty || buffer.externalChange === 'deleted'
}

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
    generation: ++bufferGenerationSequence,
    path: params.path,
    absolutePath: params.absolutePath,
    language: normalizeCodeLanguage(null, params.fileName),
    savedText: params.text,
    currentText: params.text,
    dirty: false,
    loading: false,
    error: null,
    conflict: false,
    externalChange: null,
    mtimeMs: params.mtimeMs,
    selection: params.selection ?? null,
    focusRequest: null,
  }
}

/** The user typed. Dirty derives from text comparison (not a set flag) so
 * undoing back to the saved text un-dirties the tab. Ordinary write errors
 * clear because the next save is a fresh attempt. External conflicts do not:
 * typing more cannot make a divergent/deleted disk version disappear, and
 * hiding that fact is how a later explicit overwrite becomes accidental. */
export function withTextUpdate(buffer: EditorFileBuffer, text: string): EditorFileBuffer {
  return {
    ...buffer,
    currentText: text,
    dirty: text !== buffer.savedText,
    error: buffer.conflict ? buffer.error : null,
  }
}

/** A write succeeded for the exact submitted snapshot. The user can keep
 * typing while IPC is in flight, so only the saved baseline advances; the
 * live text is never rolled back to the submitted snapshot. */
export function withWriteAcknowledged(
  buffer: EditorFileBuffer,
  writtenText: string,
  mtimeMs: number,
): EditorFileBuffer {
  return {
    ...buffer,
    savedText: writtenText,
    dirty: buffer.currentText !== writtenText,
    mtimeMs,
    error: null,
    conflict: false,
    externalChange: null,
  }
}

/** The user explicitly chose the disk version (initial open or Reload).
 * Unlike a write acknowledgement this transition intentionally replaces the
 * live text. Keeping the two operations separate makes accidental data-loss
 * call sites mechanically obvious in review. */
export function withDiskSnapshot(
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
    externalChange: null,
  }
}

/** Observe a passive disk read (watcher event, cwd reactivation, or clicking
 * an already-open file). A clean buffer may follow disk. A dirty buffer keeps
 * its original baseline and mtime so the optimistic next save still fails
 * closed; only a disk version equal to that original baseline is harmless. */
export function withDiskObserved(
  buffer: EditorFileBuffer,
  text: string,
  mtimeMs: number,
): EditorFileBuffer {
  if (!buffer.dirty) return withDiskSnapshot(buffer, text, mtimeMs)
  if (text === buffer.savedText) {
    // Disk can diverge and then return to the saved baseline. The user's edits
    // remain dirty, but the new mtime is the correct optimistic-save baseline
    // and the old external conflict no longer exists.
    return {
      ...buffer,
      mtimeMs,
      error: null,
      conflict: false,
      externalChange: null,
    }
  }
  return {
    ...buffer,
    error: 'file changed on disk while you have unsaved edits',
    conflict: true,
    externalChange: 'changed',
  }
}

let focusRequestSequence = 0

export function withFocusRequested(buffer: EditorFileBuffer): EditorFileBuffer {
  focusRequestSequence += 1
  return { ...buffer, focusRequest: focusRequestSequence }
}

export function withError(
  buffer: EditorFileBuffer,
  error: string | null,
  conflict = false,
  externalChange?: EditorFileBuffer['externalChange'],
): EditorFileBuffer {
  // A transient failure while resolving an existing disk conflict must not
  // erase the only recovery actions.
  const nextConflict = conflict || buffer.conflict
  const nextExternalChange = conflict
    ? (externalChange ?? 'changed')
    : buffer.conflict
      ? buffer.externalChange
      : (externalChange ?? null)
  return {
    ...buffer,
    error,
    conflict: nextConflict,
    externalChange: nextExternalChange,
  }
}
