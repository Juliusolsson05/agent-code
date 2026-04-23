import { ipcRenderer } from 'electron'

import type { SessionIndexEntry } from '@preload/api/types.js'

// Session prompt index — powers the Search Conversation Prompts modal.
//
// Named plural (sessions*) to match main/ipc/sessions.ts, and to
// distinguish from sessionApi's single-session lifecycle methods.
// Both handlers delegate to src/main/sessionIndex.ts which caches
// per-file parse results by mtime.

export const sessionsApi = {
  /**
   * List the most-recently-active sessions with their last few user
   * prompts attached. Powers the Search Conversation Prompts modal's
   * default (empty-query) view. Results sorted by lastModified desc.
   *
   * cwd === null means "all workspaces"; pass a cwd string to restrict
   * to sessions recorded in that cwd. Defaults: limit=10,
   * promptsPerSession=4.
   */
  listRecentSessionsWithPrompts: (options: {
    limit?: number
    promptsPerSession?: number
    cwd?: string | null
  } = {}): Promise<SessionIndexEntry[]> =>
    ipcRenderer.invoke('sessions:list-recent-with-prompts', options),

  /**
   * Search every session's user prompts for `query` (substring match,
   * case-insensitive). Ranks by match-quality × recency. Returns
   * sessions with their matched prompts prioritised, followed by
   * context prompts from the same session.
   *
   * Empty query degrades to listRecentSessionsWithPrompts.
   */
  searchSessionPrompts: (options: {
    query: string
    limit?: number
    promptsPerSession?: number
    cwd?: string | null
  }): Promise<SessionIndexEntry[]> =>
    ipcRenderer.invoke('sessions:search-prompts', options),
}
