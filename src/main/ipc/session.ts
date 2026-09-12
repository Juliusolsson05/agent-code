import { ipcMain } from 'electron'
import { createHash } from 'node:crypto'

import type { SessionManager } from '@main/sessionManager.js'
import type { PasteDebugJournalRegistry } from '@main/pasteDebugJournal.js'
import type { AppRunJournal } from '@main/incident/AppRunJournal.js'
import { sha8FromDigestBytes } from '@shared/code/sha8.js'
import type { ConditionCustomAction } from '@shared/types/providerConditions.js'
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
import { aliasScreenSnapshotForWire } from '@shared/types/session.js'
import {
  claimSessionForWindow,
  captureSessionWindowLease,
  isSessionWindowLeaseCurrent,
  releaseSession,
  sendToSessionWindow,
  sessionsOwnedBy,
  windowIdFor,
} from '@main/window/windowRegistry.js'
import type { SessionWindowLease } from '@main/window/sessionWindowRouter.js'

// One secret per app process is enough for correlation inside that run's
// incident journal, and unlike a bare SHA-256 it prevents an exported bundle
// reader from dictionary-guessing common repository paths. Cross-run joins are
// deliberately unsupported: the breadcrumb answers whether two requests in
// THIS launch targeted the same cwd without retaining the cwd itself.
// Session lifecycle + I/O IPC.
//
// Every channel here takes a sessionId (or returns one) and operates
// on a single pane's backend process. The manager owns the actual
// SessionManager / ClaudeSession / CodexSession / TerminalSession
// machinery; this file is a thin IPC adapter.
//
// Listing past conversations is not here: every picker reads the
// conversation catalog through ./conversations.ts.
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
  appRunJournal?: AppRunJournal,
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
      let lease: SessionWindowLease | null = null
      try {
        return await manager.spawn(options, sessionId => {
          lease = claimSessionForWindow(sessionId, owner)
          if (!lease) throw new Error('The requesting window can no longer own this session')
        })
      } catch (error) {
        // A failed spawn never returns its minted id to the renderer, so no
        // pane-disposal request can clean this claim later. Release only this
        // admission; a successor recovery may already have claimed the id.
        releaseSession(lease)
        throw error
      }
    },
  )

  ipcMain.handle('session:recover', async (evt, options: SessionRecoverOptions) => {
    let lease: SessionWindowLease | null = null
    const result = await manager.recover(options, () => {
      lease = claimSessionForWindow(options.sessionId, windowIdFor(evt.sender))
      if (!lease) throw new Error('This session is owned by another window or the requesting window is unavailable')
    })
    // A fresh/reloaded renderer has no previous screen even when this backend
    // is already live. The spinner gate may now suppress every subsequent
    // repaint, and an idle backend may emit none. Seed this requesting renderer
    // from the latest RAW cache after successful recovery; do not reset the
    // global gate or broadcast to unrelated windows just to satisfy one joiner.
    // Read after await so a frame received during recovery cannot be replayed
    // behind a newer cached value. Failed/conflicting recoveries reveal nothing.
    if (result.ok && !evt.sender.isDestroyed() && isSessionWindowLeaseCurrent(lease)) {
      const screen = manager.getScreenSnapshot(options.sessionId)
      if (screen) sendToSessionWindow(options.sessionId, 'session:screen', aliasScreenSnapshotForWire({ sessionId: options.sessionId, ...screen }))
    }
    return result
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

  ipcMain.handle('session:kill', async (evt, sessionId: string) => {
    const lease = captureSessionWindowLease(sessionId)
    if (lease && (lease.windowId !== windowIdFor(evt.sender) || !isSessionWindowLeaseCurrent(lease))) return false
    const killed = await manager.kill(sessionId)
    releaseSession(lease)
    return killed
  })

  ipcMain.handle('session:kill-owned', async (evt, options: SessionOwnershipOptions) => {
    const lease = captureSessionWindowLease(options.sessionId)
    // A stale window must not dispose another window's current view, even if
    // its saved provider/cwd still happen to match. Main-internal shutdown and
    // custody cleanup retain their direct manager authority.
    if (lease && (lease.windowId !== windowIdFor(evt.sender) || !isSessionWindowLeaseCurrent(lease))) return false
    const killed = await manager.killOwned(options)
    releaseSession(lease)
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

  // Snapshot for a renderer that restored after the last change event. The
  // monitor emits on change only, so without this a reload would show every
  // busy shell idle until its foreground moved again. Filtered to the caller's
  // own sessions: every window invokes this, and another window's terminals must
  // not grow runtimes here.
  ipcMain.handle('session:terminal-foregrounds', evt => {
    const windowId = windowIdFor(evt.sender)
    const owned = new Set(windowId === null ? [] : sessionsOwnedBy(windowId))
    return Object.fromEntries(
      Object.entries(manager.getTerminalForegrounds()).filter(([sessionId]) => owned.has(sessionId)),
    )
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
      // `pasteId` is set only by the Agent Code paste flow (claudePaste.ts) and
      // never by keystrokes, so it is also the exact renderer-side attribution
      // signal required by SessionManager's prompt-delivery ownership fence.
      const attributedPasteId = typeof pasteId === 'string' && pasteId.length > 0
        ? pasteId
        : null
      const ok = manager.write(
        sessionId,
        data,
        attributedPasteId ? 'renderer-paste' : 'renderer',
      )
      if (attributedPasteId) {
        // WHY the combined phase exists: Codex's zero-delay bracketed-paste
        // path writes `body + paste-end + Enter` in ONE PTY call, while Claude
        // can use separate writes. Labelling every non-bare-CR write as `body`
        // made healthy Codex captures falsely claim Enter was never attempted.
        // This describes the physical write boundary without pretending the
        // provider absorbed either component independently.
        manager.recordCodexTranscriptObservation('submit.write', sessionId, {
          phase: data === '\r'
            ? 'enter'
            : data.endsWith('\r')
              ? 'body-enter'
              : 'body',
          ok,
          deliveryInFlight,
        }, { submissionId: attributedPasteId })
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

  // Prompt delivery for API-transport agents (structured OpenCode) that have no PTY
  // to receive `session:input` keystrokes. Routes through the
  // provider-agnostic SessionManager.deliverPromptToAgent → registry
  // deliverPrompt → the provider's HTTP prompt(). Kept separate from
  // session:input because the two carry fundamentally different payloads
  // (raw terminal bytes vs a finished user prompt string) and the
  // composer chooses between them per runtime capability, not per keypress.
  // OpenCode Terminal shares the provider kind but remains on session:input.
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

  ipcMain.handle(
    'session:load-older-history',
    async (
      _evt,
      params: {
        kind: AgentProviderKind
        cwd: string
        providerSessionId: string
        beforeMarker: string
        beforeOffset?: number
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
