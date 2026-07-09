import type { SessionId, TabId } from '@renderer/workspace/types'

export type EditorPreviousSurface =
  | 'grid'
  | 'dispatch'
  | 'reader'
  | 'spotlight'
  | 'tile-tabs'

export type EditorFileBuffer = {
  path: string
  absolutePath: string
  language: string
  savedText: string
  currentText: string
  dirty: boolean
  loading: boolean
  error: string | null
  /** True when the last save failed the optimistic mtime check ("file
   *  changed on disk") or the watcher flagged an external change under a
   *  dirty buffer. Distinct from `error` (which also covers hard IO
   *  failures) because the conflict state has dedicated recovery actions
   *  (reload / overwrite) while a hard error only has retry. */
  conflict: boolean
  mtimeMs: number | null
  selection: { line: number; column: number } | null
}

export type EditorModeState = {
  open: boolean
  tabId: TabId | null
  projectRoot: string | null
  pinnedSessionId: SessionId | null
  previousSurface: EditorPreviousSurface | null
  explorerVisible: boolean
  agentRailVisible: boolean
  activeFilePath: string | null
  openFiles: Record<string, EditorFileBuffer>
  fileOrder: string[]
  lastError: string | null
}

export type EditorEnterParams = {
  tabId: TabId
  projectRoot: string
  pinnedSessionId: SessionId | null
  previousSurface: EditorPreviousSurface
}
