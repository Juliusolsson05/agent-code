import { ipcRenderer } from 'electron'

// Editor FS result types are the shared IPC contract — see
// @shared/types/editorFs. Re-exported here so existing renderer imports of
// these names from the preload barrel keep resolving.
export type {
  EditorFsEntry,
  EditorFsListResult,
  EditorFsReadResult,
  EditorFsWriteResult,
  EditorFsMutationResult,
} from '@shared/types/editorFs.js'
import type {
  EditorFsListResult,
  EditorFsReadResult,
  EditorFsWriteResult,
  EditorFsMutationResult,
} from '@shared/types/editorFs.js'

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
