import type { SessionId, TabId } from '@renderer/workspace/types'

export type EditorPreviousSurface = 'grid' | 'dispatch' | 'reader' | 'spotlight' | 'tile-tabs'

export type EditorFileBuffer = {
  /** Unique identity for this open-buffer lifetime. Async IO started before a
   * close/reopen must not mutate the replacement at the same path. */
  generation: number
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
  /** The disk-side condition behind a conflict. A deletion needs different
   * recovery actions from a changed file: there is nothing to reload, while
   * "save my copy" is a deliberate recreation. Keeping this structured avoids
   * inferring behavior from user-facing error text. */
  externalChange: 'changed' | 'deleted' | null
  mtimeMs: number | null
  selection: { line: number; column: number } | null
  /** One-shot request to move keyboard focus into this model. Tab/cwd
   * restoration must not steal focus from a terminal, while explicit tree,
   * tab, and quick-open navigation should land in the editor. */
  focusRequest: number | null
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
