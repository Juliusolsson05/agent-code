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
  EditorFsChangeEvent,
  EditorFsRecursiveListResult,
  EditorFsSearchMatch,
  EditorFsSearchResult,
} from '@shared/types/editorFs.js'
import type {
  EditorFsListResult,
  EditorFsReadResult,
  EditorFsWriteResult,
  EditorFsMutationResult,
  EditorFsChangeEvent,
  EditorFsRecursiveListResult,
  EditorFsSearchResult,
} from '@shared/types/editorFs.js'

type Unsub = () => void

// Multiplexed subscription for file-change pushes — same pattern (and
// WHY) as preload/api/lsp.ts's diagnostics bridge: buffers watch/unwatch
// as tabs open and close, and per-subscription ipcRenderer.on listeners
// would thrash Electron's IPC listener list. One process-lifetime
// listener fans out to an in-memory Set.
const fileChangeSubscribers = new Set<(event: EditorFsChangeEvent) => void>()
let fileChangeListenerInstalled = false

function subscribeFileChanges(cb: (event: EditorFsChangeEvent) => void): Unsub {
  fileChangeSubscribers.add(cb)
  if (!fileChangeListenerInstalled) {
    fileChangeListenerInstalled = true
    ipcRenderer.on(
      'editor-fs:file-changed',
      (_evt: unknown, payload: EditorFsChangeEvent) => {
        for (const subscriber of fileChangeSubscribers) subscriber(payload)
      },
    )
  }
  return () => {
    fileChangeSubscribers.delete(cb)
  }
}

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

  editorListFilesRecursive: (params: {
    root: string
  }): Promise<EditorFsRecursiveListResult> =>
    ipcRenderer.invoke('editor-fs:list-files-recursive', params),

  editorSearchContent: (params: {
    root: string
    query: string
    caseSensitive?: boolean
  }): Promise<EditorFsSearchResult> =>
    ipcRenderer.invoke('editor-fs:search-content', params),

  editorWatchFile: (params: { root: string; path: string }): Promise<void> =>
    ipcRenderer.invoke('editor-fs:watch', params),

  editorUnwatchFile: (params: { root: string; path: string }): Promise<void> =>
    ipcRenderer.invoke('editor-fs:unwatch', params),

  onEditorFileChanged: (cb: (event: EditorFsChangeEvent) => void): Unsub =>
    subscribeFileChanges(cb),
}
