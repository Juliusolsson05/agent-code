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
  mtimeMs: number | null
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
