export const SAVE_ACTIVE_EDITOR_FILE_EVENT =
  'agent-code:save-active-editor-file'
export const SAVE_ALL_EDITOR_FILES_EVENT = 'agent-code:save-all-editor-files'

/** The visible workbench owns save semantics (project-root FS vs curated AI
 * capability), while the command palette/native menu are application-level
 * surfaces. A renderer-local event keeps that direction one-way without
 * teaching the global command registry either host's filesystem authority. */
export function requestSaveActiveEditorFile(): void {
  window.dispatchEvent(new Event(SAVE_ACTIVE_EDITOR_FILE_EVENT))
}

export function requestSaveAllEditorFiles(): void {
  window.dispatchEvent(new Event(SAVE_ALL_EDITOR_FILES_EVENT))
}
