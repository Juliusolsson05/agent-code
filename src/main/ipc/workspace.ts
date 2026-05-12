import { ipcMain } from 'electron'
import { mkdir, readFile, writeFile, rename } from 'fs/promises'

import { STATE_DIR, STATE_FILE } from '@main/storage/paths.js'

// Workspace state persistence.
//
// The renderer is the source of truth for the tile tree. Main just
// reads / writes bytes — we don't interpret the JSON here. The
// atomic-write pattern (temp sibling + rename) keeps us from
// corrupting the file if the process dies mid-write.

export function registerWorkspaceIpc(): void {
  ipcMain.handle('workspace:load', async () => {
    try {
      const text = await readFile(STATE_FILE, 'utf8')
      return text
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return null // fresh install, no state yet
      throw err
    }
  })

  ipcMain.handle('workspace:save', async (_evt, json: string) => {
    await mkdir(STATE_DIR, { recursive: true })
    const tmp = STATE_FILE + '.tmp'
    await writeFile(tmp, json, 'utf8')
    await rename(tmp, STATE_FILE)
  })

  // Renderer calls this on first launch when there's no saved state
  // and no user-picked cwd yet. AGENT_CODE_CWD overrides — useful in
  // dev for launching the app pointed at a specific test project.
  // Keep CC_SHELL_CWD as a compatibility fallback for existing scripts.
  ipcMain.handle('workspace:defaultCwd', () => {
    return process.env.AGENT_CODE_CWD || process.env.CC_SHELL_CWD || process.cwd()
  })
}
