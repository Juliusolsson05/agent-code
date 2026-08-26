import { ipcMain } from 'electron'
import { mkdir, readFile, writeFile, rename } from 'fs/promises'

import { STATE_DIR, STATE_FILE } from '@main/storage/paths.js'
import type { SessionManager } from '@main/sessionManager.js'

// Workspace state persistence.
//
// The renderer is the source of truth for the tile tree. Main just
// reads / writes bytes — we don't interpret the JSON here. The
// atomic-write pattern (temp sibling + rename) keeps us from
// corrupting the file if the process dies mid-write.

export function registerWorkspaceIpc(manager: SessionManager): void {
  // WHY the whole save transaction is queued, not just writeFile: unique temp
  // names prevent scratch-path ENOENT races, but they do not order the final
  // renames. An older renderer save can be delayed, rename after a newer save,
  // and then acknowledge an ownership map that is no longer the newest one.
  // Keeping write + rename + acknowledgement on one admission-ordered tail
  // makes the bytes on disk and SessionManager's ownership commit one atomic
  // logical sequence. A rejected save is still surfaced to its IPC caller;
  // only the private tail absorbs it so later saves are not poisoned forever.
  let saveTail: Promise<void> = Promise.resolve()

  ipcMain.handle('workspace:load', async () => {
    // WHY reads join the same tail even though they do not mutate the file: an
    // unload save can be admitted before the replacement renderer asks to load
    // but still be blocked before rename. Reading around that admitted save
    // lets the new renderer reclaim old predecessor bytes just before the old
    // renderer durably writes/acknowledges the now-killed successor. Atomic
    // rename prevents corrupt bytes; this ordering prevents a valid-but-stale
    // ownership snapshot. saveTail absorbs failures, so a rejected save delays
    // the read until settlement without changing workspace:load's error shape.
    await saveTail
    try {
      const text = await readFile(STATE_FILE, 'utf8')
      return text
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return null // fresh install, no state yet
      throw err
    }
  })

  ipcMain.handle('workspace:save', (_evt, json: string) => {
    const save = saveTail.then(async () => {
      await mkdir(STATE_DIR, { recursive: true })
      // WHY this temp file is still unique even though saves are serialized:
      // the queue is process-local ordering, while the nonce is crash-safety
      // and protection from stale scratch files left by an interrupted run.
      // The final destination remains one atomic rename target.
      const tmp = `${STATE_FILE}.${process.pid}.${Date.now()}.${Math.random()
        .toString(36)
        .slice(2)}.tmp`
      await writeFile(tmp, json, 'utf8')
      await rename(tmp, STATE_FILE)
      // WHY replacement commit follows the rename: a successful spawn response
      // is not durable renderer ownership. If reload destroys the renderer before
      // its remapped local ID reaches workspace.json, main must retain the
      // predecessor transaction so rehydrate can stop the hidden successor and
      // restore the still-owned predecessor ID. Parsing is deliberately narrow;
      // main does not otherwise interpret renderer workspace state.
      try {
        const parsed = JSON.parse(json) as {
          workspace?: { sessions?: Record<string, unknown> }
        }
        const sessions = parsed.workspace?.sessions
        if (sessions && typeof sessions === 'object') {
          manager.acknowledgePersistedSessionOwnership(
            new Set(Object.keys(sessions)),
          )
        }
      } catch {
        // workspace:save historically accepts opaque bytes. A malformed payload
        // must not gain transaction authority; leaving the handoff pending is the
        // safe outcome and preserves the existing persistence error surface.
      }
    })
    saveTail = save.catch(() => undefined)
    return save
  })

  // Renderer calls this on first launch when there's no saved state
  // and no user-picked cwd yet. AGENT_CODE_CWD overrides — useful in
  // dev for launching the app pointed at a specific test project.
  ipcMain.handle('workspace:default-cwd', () => {
    return process.env.AGENT_CODE_CWD || process.cwd()
  })
}
