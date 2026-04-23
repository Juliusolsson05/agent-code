import { ipcMain } from 'electron'

// Session prompt index IPC (for Search Conversation Prompts).
//
// Both handlers route through src/main/sessionIndex.ts, which walks
// transcripts on disk and extracts user-prompt tails. Caching is
// internal to that module — repeat calls for the same session skip
// disk + parse when its mtime is unchanged.
//
// Handlers are split by intent: list-recent is the default modal
// view (no query); search is the filtered view (user typed). Both
// accept an optional cwd scope — null means "all workspaces".
//
// The dynamic import of sessionIndex is deliberate: the module loads
// a lazy index on first call and we don't want to pay that bootstrap
// cost at main startup, only when the user actually opens the modal.

export function registerSessionsIpc(): void {
  ipcMain.handle(
    'sessions:list-recent-with-prompts',
    async (
      _evt,
      options: { limit?: number; promptsPerSession?: number; cwd?: string | null } = {},
    ) => {
      const { listRecentSessionsWithPrompts } = await import('../sessionIndex.js')
      return listRecentSessionsWithPrompts(options)
    },
  )

  ipcMain.handle(
    'sessions:search-prompts',
    async (
      _evt,
      options: {
        query: string
        limit?: number
        promptsPerSession?: number
        cwd?: string | null
      },
    ) => {
      const { searchSessionPrompts } = await import('../sessionIndex.js')
      return searchSessionPrompts(options)
    },
  )
}
