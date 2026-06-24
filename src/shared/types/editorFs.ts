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

export type EditorFsListResult =
  | { ok: true; root: string; path: string; entries: EditorFsEntry[] }
  | { ok: false; error: string }

export type EditorFsReadResult =
  | { ok: true; path: string; text: string; mtimeMs: number; size: number }
  | { ok: false; error: string }

export type EditorFsWriteResult =
  // `conflict` flags an optimistic-concurrency failure (expectedMtimeMs
  // mismatch). Renderer distinguishes it from a hard error to offer
  // overwrite/reload. Keep it optional — non-conflict failures omit it.
  | { ok: true; path: string; mtimeMs: number; size: number }
  | { ok: false; error: string; conflict?: boolean }

export type EditorFsMutationResult =
  | { ok: true; path: string }
  | { ok: false; error: string }
