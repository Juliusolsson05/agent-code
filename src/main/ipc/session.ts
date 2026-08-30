import { ipcMain } from 'electron'
import { createHash } from 'node:crypto'

import type { SessionManager } from '@main/sessionManager.js'
import type { PasteDebugJournalRegistry } from '@main/pasteDebugJournal.js'
import { sha8FromDigestBytes } from '@shared/code/sha8.js'
import type { ConditionCustomAction } from '@shared/types/providerConditions.js'
import { getMainProvider } from '@providers/registry.main.js'
import { AGENT_PROVIDER_KINDS, DEFAULT_PROVIDER } from '@shared/types/providerKind.js'
import type { AgentProviderKind } from '@shared/types/providerKind.js'
import {
  loadInitialHistoryChunk,
  loadOlderHistoryChunk,
} from '@main/sessions/historyLoader.js'
import { resolveTranscriptPaths } from '@main/sessions/transcriptPaths.js'
import type { SessionSpawnOptions } from '@preload/api/types.js'
import type {
  SessionOwnershipOptions,
  SessionRecoveryCancellationOptions,
  SessionRecoverOptions,
} from '@shared/types/session.js'
import {
  claimSessionForWindow,
  releaseSession,
  windowIdFor,
} from '@main/window/windowRegistry.js'

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
//
// WHY spawn/recover/kill also talk to the window registry:
//
// This file is where a session's OWNER is established, because this is where
// the request to create one arrives and `event.sender` identifies the window
// that made it. Ownership decides which window receives the session's events
// (see windowRegistry.sendToSessionWindow). Deriving it later — from the
// persisted workspace, say — would leave every new pane unrouted for the whole
// 400ms autosave debounce, which is precisely the interval its first paint
// lands in.
//
// Ownership is NOT released when a session exits on its own: an exited pane is
// still on screen, still owned, and can be reloaded in place. It is released
// only when the owner explicitly disposes of the session.

export function registerSessionIpc(
  manager: SessionManager,
  pasteDebugJournals: PasteDebugJournalRegistry,
): void {
  ipcMain.handle(
    'session:spawn',
    async (
      evt,
      options: SessionSpawnOptions,
    ) => {
      const owner = windowIdFor(evt.sender)
      // The claim happens inside spawn at id-mint time, not out here on the
      // resolved result: the provider emits `started` and its first screen and
      // semantic events while `spawn()` is still awaiting, and those must
      // already route to this window.
      return await manager.spawn(options, sessionId =>
        claimSessionForWindow(sessionId, owner),
      )
    },
  )

  ipcMain.handle('session:recover', async (evt, options: SessionRecoverOptions) => {
    // Recovery already knows its id — the renderer supplies the durable local
    // id it is restoring — so the claim can happen before the call rather than
    // through a mint hook.
    claimSessionForWindow(options.sessionId, windowIdFor(evt.sender))
    return await manager.recover(options)
  })

  ipcMain.handle(
    'session:cancel-recovery',
    async (_evt, options: SessionRecoveryCancellationOptions) => {
      return await manager.cancelRecovery(options)
    },
  )

  ipcMain.handle('session:get-backend-snapshot', (_evt, sessionId: string) => {
    return manager.getBackendSnapshot(sessionId)
  })

  ipcMain.handle('session:kill', async (_evt, sessionId: string) => {
    const killed = await manager.kill(sessionId)
    releaseSession(sessionId)
    return killed
  })

  ipcMain.handle('session:kill-owned', async (_evt, options: SessionOwnershipOptions) => {
    const killed = await manager.killOwned(options)
    releaseSession(options.sessionId)
    return killed
  })

  ipcMain.handle('session:kind', (_evt, sessionId: string) => {
    return manager.getSessionKind(sessionId)
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
        const sha8 = sha8FromDigestBytes(createHash('sha256').update(data).digest())
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
      // Sampled BEFORE the write so the log describes the state the write
      // actually met. Sampling afterwards races a delivery that released in
      // between and reports the wrong cause — the same misdiagnosis this
      // replaces, just narrower.
      const deliveryInFlight = manager.isDeliveryInFlight(sessionId)
      const ok = manager.write(sessionId, data)
      if (typeof pasteId === 'string' && pasteId.length > 0) {
        // One pasteId already spans every low-level body/Enter write for a
        // composer submit. Preserve those boundaries as separate observations
        // instead of collapsing `ok` into a fictional atomic provider submit.
        manager.recordCodexTranscriptObservation('submit.write', sessionId, {
          phase: data === '\r' ? 'enter' : 'body',
          ok,
          deliveryInFlight,
        }, { submissionId: pasteId })
      }
      if (!ok) {
        // WHY both facts instead of one verdict: this used to log "missing
        // session" unconditionally, which is wrong for the far more common
        // case — the session exists and a prompt delivery holds the write
        // reservation. That message sent the Codex trust-dialog investigation
        // hunting a lifecycle bug when the real cause was contention. Log what
        // was observed and let the reader conclude; a wrong verdict in a log is
        // worse than no verdict.
        // eslint-disable-next-line no-console
        console.warn('[session:input] dropped write', {
          sessionId,
          deliveryInFlight,
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

  // Prompt delivery for API-transport agents (opencode) that have no PTY
  // to receive `session:input` keystrokes. Routes through the
  // provider-agnostic SessionManager.deliverPromptToAgent → registry
  // deliverPrompt → the provider's HTTP prompt(). Kept separate from
  // session:input because the two carry fundamentally different payloads
  // (raw terminal bytes vs a finished user prompt string) and the
  // composer chooses between them per provider capability, not per keypress.
  ipcMain.handle(
    'session:deliver-prompt',
    async (
      _evt,
      sessionId: string,
      prompt: string,
      imagePaths?: string[],
      deliveryId?: string,
    ) => {
      const record = typeof deliveryId === 'string' && deliveryId.length > 0
        ? (event: string, data?: Record<string, unknown>) => {
            pasteDebugJournals.get(deliveryId).append({
              layer: 'PTY',
              event: `delivery:${event}`,
              data: { sessionId, ...data },
            })
          }
        : undefined
      return await manager.deliverPromptToAgent(sessionId, prompt, imagePaths, record)
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
      provider: AgentProviderKind = DEFAULT_PROVIDER,
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
        // Derived list: a newly registered provider is automatically
        // included in the global inventory (#394 phase 1 — this was a
        // hand-rolled pair that would silently omit a third provider).
        const providers = AGENT_PROVIDER_KINDS
        const listed = await Promise.all(providers.map(async provider => {
          const providerConfig = getMainProvider(provider)
          if (!providerConfig.listAllSessions) return []
          const sessions = await providerConfig.listAllSessions(cap).catch(() => [])
          return sessions.map(s => ({ ...s, provider }))
        }))
        const tagged = listed.flat()
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
        kind: AgentProviderKind
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
        kind: AgentProviderKind
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
        kind: AgentProviderKind
        cwd: string
        providerSessionId: string
      }>,
    ) => {
      return await resolveTranscriptPaths(requests)
    },
  )
}
