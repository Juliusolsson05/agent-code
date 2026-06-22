import { ipcMain } from 'electron'
import { createHash } from 'node:crypto'

import type { SessionManager } from '@main/sessionManager.js'
import type { PasteDebugJournalRegistry } from '@main/pasteDebugJournal.js'
import type { ConditionCustomAction } from '@shared/types/providerConditions.js'
import { getMainProvider } from '@providers/registry.main.js'
import { listAllClaudeSessions } from '@providers/claude/runtime/sessionList.js'
import { listCodexSessions } from '@providers/codex/runtime/sessionList.js'
import {
  loadInitialHistoryChunk,
  loadOlderHistoryChunk,
} from '@main/sessions/historyLoader.js'
import { resolveTranscriptPaths } from '@main/sessions/transcriptPaths.js'
import type { BuiltInMcpDomain } from '@mcp/shared/types.js'

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

export function registerSessionIpc(
  manager: SessionManager,
  pasteDebugJournals: PasteDebugJournalRegistry,
): void {
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
        builtInMcpDomains?: BuiltInMcpDomain[]
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

  // Agent PTY attach/replay. DebugPanel uses this for Claude
  // and Codex panes when the user asks to see the raw underlying TUI
  // as an xterm terminal. Kept separate from terminal-attach because
  // plain terminal panes and agent panes have different primary
  // renderers and different live IPC channels.
  ipcMain.handle('session:agent-pty-attach', (_evt, sessionId: string) => {
    return manager.attachAgentPty(sessionId)
  })

  ipcMain.handle('session:agent-pty-detach', (_evt, sessionId: string) => {
    manager.detachAgentPty(sessionId)
  })

  ipcMain.handle(
    'session:input',
    (_evt, sessionId: string, data: string, pasteId?: string) => {
      // Optional pasteId journals THIS write into the per-paste debug
      // dump. Only set by the Agent Code paste flow (claudePaste.ts) —
      // never set on keystrokes, agent-pty bridging, or other normal
      // I/O. Pairs against the renderer's IPC:write:* events by sha8
      // + byte count, same way dictation pairs renderer-produced
      // against main-received chunks (PR #68).
      if (typeof pasteId === 'string' && pasteId.length > 0) {
        const bytes = Buffer.byteLength(data, 'utf8')
        const sha8 = createHash('sha256').update(data).digest('hex').slice(0, 8)
        // Head preview is escape-safe: replace ESC with `\e` and CR
        // with `\r` so the JSONL line is readable when you cat the
        // file. The raw bytes are never logged — sha8 is the
        // correlation primitive.
        const head = data.slice(0, 40).replace(/\x1b/g, '\\e').replace(/\r/g, '\\r')
        pasteDebugJournals.get(pasteId).append({
          layer: 'PTY',
          event: 'main:write',
          data: { sessionId, bytes, sha8, head },
        })
      }
      const ok = manager.write(sessionId, data)
      if (!ok) {
        // eslint-disable-next-line no-console
        console.warn('[session:input] dropped write for missing session', {
          sessionId,
          dataLength: data.length,
        })
        if (typeof pasteId === 'string' && pasteId.length > 0) {
          pasteDebugJournals.get(pasteId).append({
            layer: 'ERROR',
            event: 'main:write-dropped-no-session',
            data: { sessionId },
          })
        }
      }
      return ok
    },
  )

  ipcMain.handle(
    'session:resolveCondition',
    async (_evt, sessionId: string, action: ConditionCustomAction) => {
      return await manager.resolveCondition(sessionId, action)
    },
  )

  ipcMain.handle(
    'session:resize',
    (_evt, sessionId: string, cols: number, rows: number) => {
      manager.resize(sessionId, cols, rows)
    },
  )

  // Event-driven paste-submit (Track C of the paste-submit harness PR).
  // Renderer's claudePaste.ts invokes this AFTER writing the bracketed
  // paste payload but BEFORE writing `\r`. We resolve as soon as
  // Claude's TUI renders `[Pasted text #N]`, falling back to a 2 s
  // timeout if the placeholder never appears (future Claude UI rename
  // insurance). See `claudePaste.ts` and
  // `packages/claude-code-headless/src/ClaudeCodeHeadless.ts:awaitPastePlaceholder`
  // for the full rationale chain.
  ipcMain.handle(
    'claude:await-paste-placeholder',
    async (
      _evt,
      sessionId: string,
      opts?: { timeoutMs?: number; pollIntervalMs?: number },
    ) => {
      return manager.awaitClaudePastePlaceholder(sessionId, opts)
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

  ipcMain.handle(
    'session:load-initial-history',
    async (
      _evt,
      params: {
        kind: 'claude' | 'codex'
        cwd: string
        providerSessionId: string
        limit?: number
      },
    ) => {
      return await loadInitialHistoryChunk({
        ...params,
        limit: params.limit ?? 120,
      })
    },
  )

  ipcMain.handle(
    'session:resolve-transcript-paths',
    async (
      _evt,
      requests: Array<{
        sessionId: string
        kind: 'claude' | 'codex'
        cwd: string
        providerSessionId: string
      }>,
    ) => {
      return await resolveTranscriptPaths(requests)
    },
  )
}
