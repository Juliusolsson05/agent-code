// Editor filesystem IPC contract.
//
// WHY shared: these result shapes cross the renderer↔main boundary three
// ways — main produces them (`src/main/ipc/editorFs.ts`), preload bridges
// them (`src/preload/api/editorFs.ts`), and the renderer consumes them
// (`ExplorerPane.tsx`). They were previously declared by identical text in
// all three places, so a main-side field addition or a changed failure
// variant could leave preload/renderer compiling against a stale copy with
// no error. One definition removes that drift class.
//
// INVARIANT: the trust boundary (path containment, allow-list, conflict
// detection) stays in `src/main/ipc/editorFs.ts`. This file is types only —
// moving the shape here must NOT move any filesystem validation.

export type EditorFsEntry = {
  name: string
  path: string
  isDirectory: boolean
  /** `null` for directories / when size is unknown. Kept nullable so the
   *  renderer never assumes a number for a dir row. */
  size: number | null
  mtimeMs: number
}

/** Opaque main-process file identity. Consumers may persist it only for the
 * lifetime of an open buffer and must compare it for equality, never parse it. */
export type EditorFsFileVersion = string

export type EditorFsListResult =
  | {
      ok: true
      root: string
      path: string
      entries: EditorFsEntry[]
      truncated: boolean
    }
  | { ok: false; error: string }

export type EditorFsReadResult =
  | {
      ok: true
      path: string
      /** Absolute identity under main's canonical project root, used for
       * Monaco model URIs. `path` remains project-relative UI identity;
       * keeping both avoids symlinked worktrees making valid definition
       * targets look outside the project. */
      absolutePath: string
      text: string
      mtimeMs: number
      size: number
      version: EditorFsFileVersion
    }
  | { ok: false; error: string }

export type EditorFsWriteResult =
  // `conflict` flags an optimistic-concurrency failure. Renderer distinguishes
  // it from a hard error to offer
  // overwrite/reload. Keep it optional — non-conflict failures omit it.
  | {
      ok: true
      path: string
      mtimeMs: number
      size: number
      version: EditorFsFileVersion
    }
  | {
      ok: false
      error: string
      conflict?: boolean
      conflictKind?: 'changed' | 'deleted'
    }

export type EditorFsMutationResult = { ok: true; path: string } | { ok: false; error: string }

/** Pushed on `editor-fs:file-changed` for files registered via
 *  `editor-fs:watch`. `mtimeMs` is null when the post-change stat failed
 *  (fast delete-after-write) — consumers treat that like a change and
 *  revalidate by re-reading. */
export type EditorFsChangeEvent = {
  root: string
  path: string
  kind: 'change' | 'unlink' | 'error'
  mtimeMs: number | null
  error?: string
}

/** An expanded Explorer directory changed membership. The child name is
 * intentionally omitted: renderer reloads the bounded authoritative listing
 * rather than trying to reproduce rename/filter/sort semantics from events. */
export type EditorFsDirectoryChangeEvent = {
  root: string
  path: string
  /** Present when the native subscription stopped being trustworthy. */
  error?: string
}

export type EditorFsRecursiveListResult =
  | {
      ok: true
      files: string[]
      truncated: boolean
      partial: boolean
      errorCount: number
    }
  | { ok: false; error: string }

export type EditorFsSearchMatch = {
  path: string
  /** 1-based — these are UI-facing (openFileInGlobalEditor selection). */
  line: number
  column: number
  /** The matched line, trimmed to ≤200 chars around the hit. */
  preview: string
  /** Zero-based match offset inside preview. `column` is relative to the full
   * line and cannot identify repeated matches after the preview is clipped. */
  previewMatchOffset: number
  /** UTF-16 length of the exact matched text in `preview`. Unicode
   * case-insensitive matching is not guaranteed to have query.length. */
  previewMatchLength: number
}

export type EditorFsSearchStopReason =
  'complete' | 'matches' | 'files' | 'bytes' | 'deadline' | 'cancelled'

export type EditorFsSearchResult =
  | {
      ok: true
      matches: EditorFsSearchMatch[]
      truncated: boolean
      filesScanned: number
      partial: boolean
      errorCount: number
      stopReason: EditorFsSearchStopReason
    }
  | { ok: false; error: string }
