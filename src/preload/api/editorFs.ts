import { ipcRenderer } from 'electron'

export type EditorFsEntry = {
  name: string
  path: string
  isDirectory: boolean
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
  | { ok: true; path: string; mtimeMs: number; size: number }
  | { ok: false; error: string; conflict?: boolean }

export type EditorFsMutationResult =
  | { ok: true; path: string }
  | { ok: false; error: string }

// Editor filesystem bridge.
//
// WHY this is separate from fsApi: the existing fs:* IPC surface is a path
// picker helper with user-home expansion semantics. The editor needs a
// project-root-scoped document API with path containment, conflict detection,
// and future file-watcher hooks. Mixing those contracts would make both harder
// to reason about and would tempt callers to use picker helpers for writes.
export const editorFsApi = {
  editorListDirectory: (params: {
    root: string
    path?: string
    showHidden?: boolean
  }): Promise<EditorFsListResult> =>
    ipcRenderer.invoke('editor-fs:list-directory', params),

  editorReadTextFile: (params: {
    root: string
    path: string
  }): Promise<EditorFsReadResult> =>
    ipcRenderer.invoke('editor-fs:read-text-file', params),

  editorWriteTextFile: (params: {
    root: string
    path: string
    text: string
    expectedMtimeMs?: number | null
  }): Promise<EditorFsWriteResult> =>
    ipcRenderer.invoke('editor-fs:write-text-file', params),

  editorCreateFile: (params: {
    root: string
    path: string
  }): Promise<EditorFsMutationResult> =>
    ipcRenderer.invoke('editor-fs:create-file', params),

  editorCreateDirectory: (params: {
    root: string
    path: string
  }): Promise<EditorFsMutationResult> =>
    ipcRenderer.invoke('editor-fs:create-directory', params),

  editorRename: (params: {
    root: string
    fromPath: string
    toPath: string
  }): Promise<EditorFsMutationResult> =>
    ipcRenderer.invoke('editor-fs:rename', params),

  editorDelete: (params: {
    root: string
    path: string
  }): Promise<EditorFsMutationResult> =>
    ipcRenderer.invoke('editor-fs:delete', params),
}
