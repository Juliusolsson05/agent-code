import { ipcMain } from 'electron'

import type { SessionManager } from '../sessionManager.js'
import { getMainProvider } from '@providers/registry.main.js'
import { listAllClaudeSessions } from '@providers/claude/runtime/sessionList.js'
import { listCodexSessions } from '@providers/codex/runtime/sessionList.js'
import { loadOlderHistoryChunk } from '../sessions/historyLoader.js'

// Session lifecycle + I/O IPC.
//
// Every channel here takes a sessionId (or returns one) and operates
// on a single pane's backend process. The manager owns the actual
// SessionManager / ClaudeSession / CodexSession / TerminalSession
// machinery; this file is a thin IPC adapter.
//
// Listing handlers live here too (list-for-cwd, list-all) because
// they're "session lifecycle from the user's POV" — the resume
// picker asks "what sessions could I spawn?" before calling spawn.
// The prompt-indexing handlers (sessions:*) live in ./sessions.ts
// because they're a separate concern with their own cache layer.

export function registerSessionIpc(manager: SessionManager): void {
  ipcMain.handle(
    'session:spawn',
    async (
      _evt,
      options: {
        kind?: 'claude' | 'codex' | 'terminal'
        cwd: string
        cols?: number
        rows?: number
        resumeSessionId?: string
        dangerousMode?: boolean
        useProxy?: boolean
        recoverTmuxName?: string
      },
    ) => {
      return await manager.spawn(options)
    },
  )

  ipcMain.handle('session:kill', async (_evt, sessionId: string) => {
    return await manager.kill(sessionId)
  })

  // Terminal attach/replay. Called once by TerminalLeaf on mount.
  // Returns the full buffered output of the session so far AND flips
  // the manager's "attached" flag so subsequent PTY data events
  // broadcast live. See SessionManager.terminalBuffers for the race
  // being fixed.
  ipcMain.handle('session:terminal-attach', (_evt, sessionId: string) => {
    return manager.attachTerminal(sessionId)
  })

  ipcMain.handle(
    'session:input',
    (_evt, sessionId: string, data: string) => {
      const ok = manager.write(sessionId, data)
      if (!ok) {
        // eslint-disable-next-line no-console
        console.warn('[session:input] dropped write for missing session', {
          sessionId,
          dataLength: data.length,
        })
      }
      return ok
    },
  )

  ipcMain.handle(
    'session:resize',
    (_evt, sessionId: string, cols: number, rows: number) => {
      manager.resize(sessionId, cols, rows)
    },
  )

  // Session listing for the resume picker.
  //
  // Called by PathPickerModal when the user types a cwd — returns a
  // list of previous sessions in that directory so they can resume
  // one instead of starting fresh. Empty array when the cwd has no
  // recorded history yet. Per-provider listing routes through the
  // provider registry so each format reads its own storage.
  ipcMain.handle(
    'session:list-for-cwd',
    async (
      _evt,
      cwd: string,
      limit?: number,
      provider: 'claude' | 'codex' = 'claude',
    ) => {
      try {
        const providerConfig = getMainProvider(provider)
        return await providerConfig.listSessions(cwd, limit ?? 20)
      } catch (err) {
        // Don't let a listing error brick the modal — return empty.
        // eslint-disable-next-line no-console
        console.warn('[session:list-for-cwd] failed:', err)
        return []
      }
    },
  )

  // Global session listing (used by the rendering-debug harness).
  // The main app routes through `session:list-for-cwd` because it
  // filters by the focused pane's cwd; the harness has no notion of
  // "current cwd" and needs everything tagged with provider.
  ipcMain.handle(
    'session:list-all',
    async (_evt, limit?: number) => {
      const cap = typeof limit === 'number' && limit > 0 ? limit : 200
      try {
        const [claude, codex] = await Promise.all([
          listAllClaudeSessions({ limit: cap }).catch(() => []),
          listCodexSessions({ limit: cap }).catch(() => []),
        ])
        const tagged = [
          ...claude.map(s => ({ ...s, provider: 'claude' as const })),
          ...codex.map(s => ({ ...s, provider: 'codex' as const })),
        ]
        tagged.sort((a, b) => b.lastModified - a.lastModified)
        return tagged.slice(0, cap)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[session:list-all] failed:', err)
        return []
      }
    },
  )

  ipcMain.handle(
    'session:load-older-history',
    async (
      _evt,
      params: {
        kind: 'claude' | 'codex'
        cwd: string
        providerSessionId: string
        beforeMarker: string
        limit?: number
      },
    ) => {
      return await loadOlderHistoryChunk({
        ...params,
        limit: params.limit ?? 200,
      })
    },
  )
}
