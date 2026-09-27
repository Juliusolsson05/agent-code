import { ipcMain } from 'electron'
import { createHash } from 'node:crypto'

import { ProviderCliNotFoundError, type SessionManager } from '@main/sessionManager.js'
import { MissingWorkspaceDirectoryError } from '@main/workspaceDirectory.js'
import { CLAUDE_PROXY_STARTUP_FAILED_MESSAGE, isClaudeProxyStartupFailure, SESSION_START_FAILED_MESSAGE } from '@shared/types/session.js'
import { mainOperations } from '@main/performance/operations.js'
import type { PasteDebugJournalRegistry } from '@main/pasteDebugJournal.js'
import type { AppRunJournal } from '@main/incident/AppRunJournal.js'
import { sha8FromDigestBytes } from '@shared/code/sha8.js'
import type { ConditionCustomAction } from '@shared/types/providerConditions.js'
import type { AgentProviderKind } from '@shared/types/providerKind.js'
import type { PromptDeliveryOptions } from '@shared/types/providerConfig.js'
import {
  loadInitialHistoryChunk,
  loadOlderHistoryChunk,
} from '@main/sessions/historyLoader.js'
import { resolveTranscriptPaths } from '@main/sessions/transcriptPaths.js'
import type { SessionFeedTap } from '@main/sessions/sessionFeedTap.js'
import type { SessionSpawnOptions } from '@preload/api/types.js'
import type {
  SessionKillOptions,
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
import { screenInterest, screenTailHistory } from '@main/sessions/screenInterest.js'
import type { AgentScreenSnapshot } from '@shared/types/session.js'
import type { ScreenTailSample } from '@shared/debug/screenTail.js'

const WINDOW_CANNOT_OWN_SESSION = 'The requesting window can no longer own this session'

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
  // The shared session feed tap (#1177), for the one ordering barrier this
  // file owns: deliver-prompt flushes committed rows before replying (#1181).
  feedTap: Pick<SessionFeedTap, 'flushCommitted'>,
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
          if (!lease) throw new Error(WINDOW_CANNOT_OWN_SESSION)
        })
      } catch (error) {
        // A failed spawn never returns its minted id to the renderer, so no
        // pane-disposal request can clean this claim later. Release only this
        // admission; a successor recovery may already have claimed the id.
        releaseSession(lease)
        throw launderSpawnError(error, options, appRunJournal)
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

  /**
   * Re-emit each session's cached provider-conditions snapshot to the window
   * that owns it, on the ORDINARY event channel (#895).
   *
   * WHY the renderer asks, rather than main pushing when it transfers routing:
   * every path that needs this — adopting a closed window's sessions, a cold
   * restore, waking a parked agent — rebuilds the runtime from `emptyRuntime()`
   * AFTER its own `invoke` resolves. A snapshot delivered before that seed is
   * simply overwritten by it. The renderer is the only side that knows when
   * its runtimes exist.
   *
   * WHY the event channel and not the reply to that invoke: conditions have no
   * revision, and a reply raced against live events cannot be ordered against
   * them. The first attempt at #895 carried the snapshot on
   * `SessionBackendSnapshot` and compared `ts` — and 1 ms `Date.now()` ties are
   * genuinely unordered (OpenCode emits several snapshots per millisecond with
   * no dedupe latch), so a prompt answered in the same millisecond it appeared
   * could be RESTORED onto the user's screen. On this channel there is nothing
   * to order: main updates its cache before forwarding, so the cache is never
   * older than what the renderer has already folded, and the re-emit is just
   * the next event in the same stream. The renderer's own handler then applies
   * the one projection, the unread mark and the debug log, exactly as it does
   * for a live change — `session:resync-routing` seeds the same way, for the
   * same reason.
   *
   * Ownership is checked per session, so a stale request cannot make main
   * deliver another window's state.
   */
  ipcMain.handle('session:reseed-conditions', (evt, sessionIds: string[]): number => {
    if (!Array.isArray(sessionIds)) return 0
    let delivered = 0
    for (const sessionId of sessionIds) {
      if (typeof sessionId !== 'string' || !sessionId) continue
      const lease = captureSessionWindowLease(sessionId)
      if (!lease || lease.windowId !== windowIdFor(evt.sender) || !isSessionWindowLeaseCurrent(lease)) continue
      const snapshot = manager.getConditionsSnapshot(sessionId)
      // No cached snapshot means no condition has ever been live for this
      // session. Sending nothing is the honest answer; an empty snapshot would
      // be a claim that everything is clear, which is a different statement.
      if (!snapshot) continue
      if (sendToSessionWindow(sessionId, 'session:conditions', { sessionId, snapshot }) === 'delivered') delivered += 1
    }
    return delivered
  })

  ipcMain.handle('session:kill', async (evt, sessionId: string) => {
    const lease = captureSessionWindowLease(sessionId)
    if (lease && (lease.windowId !== windowIdFor(evt.sender) || !isSessionWindowLeaseCurrent(lease))) return false
    // No caller on this legacy id-only channel: it has no renderer consumer
    // today, so a kill.request with `caller: 'unknown'` from here is itself the
    // signal that something started using it (#1135).
    const killed = await manager.kill(sessionId)
    releaseSession(lease)
    return killed
  })

  ipcMain.handle('session:kill-owned', async (evt, options: SessionKillOptions) => {
    const lease = captureSessionWindowLease(options.sessionId)
    // A stale window must not dispose another window's current view, even if
    // its saved provider/cwd still happen to match. Main-internal shutdown and
    // custody cleanup retain their direct manager authority.
    if (lease && (lease.windowId !== windowIdFor(evt.sender) || !isSessionWindowLeaseCurrent(lease))) return false
    // `options.caller` is forwarded untouched; killOwned re-validates it
    // against KILL_CALLERS, so a renderer cannot write free text into the
    // journal through it.
    const killed = await manager.killOwned(options)
    // WHY the release is conditional (#935 Codex review): killOwned returns
    // false for two different situations. One is "there was nothing to close"
    // — an already-exited pane being cleaned up, where releasing the claim is
    // exactly right. The other is "this request does not own that backend":
    // a stale pane whose saved cwd or provider no longer matches the live
    // session. Releasing there revoked the display claim of a session that is
    // still running, and since this branch removes the broadcast fallback its
    // output was then quarantined with no owner left to show the gap — the
    // pane simply went quiet. `retainsSessionOwnership` asks the same four
    // tables killOwned consults, because a backend snapshot alone is not
    // enough: mid-handoff a Codex predecessor has no snapshot while its
    // replacement reservation still owns it (#935 Codex delta review).
    if (killed || !manager.retainsSessionOwnership(options.sessionId)) releaseSession(lease)
    return killed
  })

  ipcMain.handle('session:kind', (_evt, sessionId: string) => {
    return manager.getSessionKind(sessionId)
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

  // Raw views (agent PTY xterms and plain-terminal leaves) are OWNED by the
  // calling renderer page (#1311 review for agents, #1283 item 3 for
  // terminals), the same lifecycle as the screen leases below. Main's attach
  // counts outlive the process (a same-id wake keeps a mounted view live,
  // #1281), so a renderer that reloads or crashes without running its leaf
  // cleanup would otherwise pin a count forever: bytes forwarded to nobody,
  // and for agents a restore size applied to some later process. Each
  // renderer's outstanding attaches are released when it is destroyed or
  // loads a new document.
  //
  // WHY one table per view type from one factory, rather than the agent-only
  // table this used to be plus a copy for terminals: the terminal half of
  // #1281 needs exactly the same take / give-back-only-what-you-hold /
  // release-on-reload rules, and two hand-written copies are how one of them
  // drifts. `detach` is the manager call one reference is worth.
  const rawViewOwnership = (detach: (sessionId: string) => void) => {
    const byOwner = new Map<number, Map<string, number>>()
    return {
      take(owner: number, sessionId: string): void {
        const owned = byOwner.get(owner) ?? new Map<string, number>()
        owned.set(sessionId, (owned.get(sessionId) ?? 0) + 1)
        byOwner.set(owner, owned)
      },
      /** Give back one reference this owner holds; one it does not hold is ignored. */
      give(owner: number, sessionId: string): void {
        const owned = byOwner.get(owner)
        const count = owned?.get(sessionId) ?? 0
        if (count === 0) return
        if (count === 1) owned!.delete(sessionId)
        else owned!.set(sessionId, count - 1)
        if (owned!.size === 0) byOwner.delete(owner)
        detach(sessionId)
      },
      releaseOwner(owner: number): void {
        const owned = byOwner.get(owner)
        if (!owned) return
        byOwner.delete(owner)
        for (const [sessionId, count] of owned) {
          for (let i = 0; i < count; i += 1) detach(sessionId)
        }
      },
    }
  }
  const agentPtyViews = rawViewOwnership(sessionId => manager.detachAgentPty(sessionId))
  const terminalViews = rawViewOwnership(sessionId => manager.detachTerminal(sessionId))
  // Each renderer's current page document, so only a real reload releases.
  const rawViewDocuments = new Map<number, string>()
  const releaseRawViews = (owner: number): void => {
    agentPtyViews.releaseOwner(owner)
    terminalViews.releaseOwner(owner)
  }
  // Is this call from the renderer's CURRENT page? #1311 round 2 (review A):
  // a reload can keep the webContents id, so the sender alone cannot tell
  // the dead page's queued detach from the live page's; without the page
  // document, that late detach took the new page's only reference and froze
  // its terminal. The preload stamps every call with its document (minted
  // once per load, the same token the screen leases carry). A renderer that
  // has not announced yet adopts the caller's document, which its own
  // announcement then confirms.
  const isCurrentRawViewDocument = (owner: number, document: string): boolean => {
    const current = rawViewDocuments.get(owner)
    if (current === undefined) {
      rawViewDocuments.set(owner, document)
      return true
    }
    return current === document
  }

  // Agent PTY attach/replay. DebugPanel uses this for Claude
  // and Codex panes when the user asks to see the raw underlying TUI
  // as an xterm terminal. Kept separate from terminal-attach because
  // plain terminal panes and agent panes have different primary
  // renderers and different live IPC channels.
  ipcMain.handle('session:agent-pty-attach', (evt, sessionId: string, document: string) => {
    const owner = watchLeaseOwner(evt.sender)
    // A dead page's attach must take no reference: nothing would release it,
    // because that page's release already ran.
    if (!isCurrentRawViewDocument(owner, document)) return null
    const buffer = manager.attachAgentPty(sessionId)
    // null = no backend, and main took no reference; nothing to own.
    if (buffer === null) return buffer
    agentPtyViews.take(owner, sessionId)
    return buffer
  })

  ipcMain.handle('session:agent-pty-detach', (evt, sessionId: string, document: string) => {
    // Only a reference the CURRENT page holds. After a reload released the
    // old page's references, its late detach must not take the new page's.
    if (rawViewDocuments.get(evt.sender.id) !== document) return
    agentPtyViews.give(evt.sender.id, sessionId)
  })

  // Terminal attach/replay. Called once by TerminalLeaf per session id.
  // Returns the full buffered output of the session so far AND takes a view
  // reference so subsequent PTY data events broadcast live. See
  // SessionManager.terminalBuffers for the race being fixed. Same page
  // ownership as the agent PTY above (#1283 item 3): the reference used to be
  // a manager flag no renderer could release, cleared only by the shell's
  // exit, which is what froze a mounted leaf across a same-id respawn (#1281).
  ipcMain.handle('session:terminal-attach', (evt, sessionId: string, document: string) => {
    const owner = watchLeaseOwner(evt.sender)
    // A dead page gets the replay for nothing: no reference, since nothing
    // would release it. '' keeps the renderer contract a plain string.
    if (!isCurrentRawViewDocument(owner, document)) return ''
    const buffer = manager.attachTerminal(sessionId)
    // null = not a terminal: main took no reference, so there is none to own.
    if (buffer === null) return ''
    terminalViews.take(owner, sessionId)
    return buffer
  })

  ipcMain.handle('session:terminal-detach', (evt, sessionId: string, document: string) => {
    if (rawViewDocuments.get(evt.sender.id) !== document) return
    terminalViews.give(evt.sender.id, sessionId)
  })

  // #762. Live `session:screen` frames are forwarded only while a renderer
  // holds a lease for that session (see sessions/screenInterest.ts for why
  // nothing else needs them). The acquire also pushes the current screen down
  // the ordinary `session:screen` path, the same seed `session:recover` sends,
  // so an opening debug panel is correct at once even for an idle backend that
  // emits no further frame, and the renderer needs no second way to apply a
  // screen. Leases are owned by the calling webContents and document (see
  // sessions/screenInterest.ts for why not a navigation event), and dropped
  // when the webContents is destroyed, because a renderer that dies never
  // runs its cleanup.
  const leaseOwnersWatched = new Set<number>()
  const watchLeaseOwner = (sender: Electron.WebContents): number => {
    const owner = sender.id
    if (!leaseOwnersWatched.has(owner)) {
      leaseOwnersWatched.add(owner)
      sender.once('destroyed', () => {
        screenInterest.dropOwner(owner)
        releaseRawViews(owner)
        rawViewDocuments.delete(owner)
        leaseOwnersWatched.delete(owner)
      })
    }
    return owner
  }
  // Sent by the preload on every page load, whether or not the page ever
  // leases: it is what retires a reloaded page's leases (steering q15).
  ipcMain.handle('session:screen-document', (evt, document: string): void => {
    const owner = watchLeaseOwner(evt.sender)
    screenInterest.enterDocument(owner, document)
    // A NEW document is a page load: the previous page's raw views (agent
    // PTY and terminal attaches) died with it. A re-announce of the live
    // document changes nothing.
    const previous = rawViewDocuments.get(owner)
    rawViewDocuments.set(owner, document)
    if (previous !== undefined && previous !== document) releaseRawViews(owner)
  })
  ipcMain.handle('session:screen-lease', (evt, sessionId: string, document: string): void => {
    screenInterest.acquire(watchLeaseOwner(evt.sender), sessionId, document)
    const screen = manager.getScreenSnapshot(sessionId)
    if (screen) sendToSessionWindow(sessionId, 'session:screen', aliasScreenSnapshotForWire({ sessionId, ...screen }))
  })
  ipcMain.handle('session:screen-release', (evt, sessionId: string, document: string) => {
    screenInterest.release(evt.sender.id, sessionId, document)
  })
  // Debug bundles read the screen on demand instead of holding a lease: the
  // latest raw snapshot plus the tail history main records from every frame.
  ipcMain.handle('session:get-screen-debug', (_evt, sessionId: string): {
    screen: AgentScreenSnapshot | null
    samples: ScreenTailSample[]
  } => ({
    screen: manager.getScreenSnapshot(sessionId),
    samples: screenTailHistory.samples(sessionId),
  }))

  ipcMain.handle(
    'session:input',
    (_evt, sessionId: string, data: string, pasteId?: string) => {
      // Optional pasteId journals THIS write into the per-paste debug
      // dump. Only set by the composer's paste flow (useComposerKeybinds) —
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
      // `pasteId` is set only by the composer's paste flow (useComposerKeybinds) and
      // never by keystrokes, so it is also the exact renderer-side attribution
      // signal required by SessionManager's prompt-delivery ownership fence.
      const attributedPasteId = typeof pasteId === 'string' && pasteId.length > 0
        ? pasteId
        : null
      const finishDelivery = attributedPasteId ? mainOperations.begin('prompt.delivery', sessionId, attributedPasteId) : null
      const ok = manager.write(
        sessionId,
        data,
        attributedPasteId ? 'renderer-paste' : 'renderer',
      )
      finishDelivery?.(ok ? 'success' : 'error')
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

  // Jump to Latest for a provider whose TUI owns its transcript scrollback
  // (#843). A fixed request, never a command string from the renderer: the
  // route beneath it can run any TUI command, including destructive ones.
  ipcMain.handle('session:jumpToLatest', async (_evt, sessionId: string) => {
    return await manager.jumpToLatest(sessionId)
  })

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
      options?: PromptDeliveryOptions,
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
      const result = await manager.deliverPromptToAgent(sessionId, prompt, imagePaths, record, deliveryId,
        options?.requireEmptyNativeComposer === true ? { requireEmptyNativeComposer: true } : undefined)
      // ORDER BARRIER (#1181): send the committed rows before the answer.
      // Claude's acceptance IS main seeing the prompt's JSONL line, and that
      // line is buffered in the session feed tap's JSONL burst and sent on the next
      // setImmediate. The reply to this invoke would otherwise overtake it,
      // because the await above resumes in a microtask. The renderer removes
      // its pending "Sending…" row the moment the reply lands. Without this
      // flush the prompt blinked out of the feed until the batch arrived
      // (PR #1183 review, Claude 1). Both messages then travel the same
      // renderer channel in this order. Flushing early costs nothing: it is
      // the same batch, just sent now, and an empty buffer is a no-op.
      feedTap.flushCommitted(sessionId)
      return result
    },
  )

  ipcMain.handle(
    'session:resize',
    (_evt, sessionId: string, cols: number, rows: number) => {
      manager.resize(sessionId, cols, rows)
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

/**
 * What a failed session:spawn tells the renderer (#1267, steering q22 at the
 * source). IPC relays only an error's message, and a provider launch
 * exception can carry environment values, proxy URLs or scoped MCP tokens;
 * every renderer surface used to have to remember not to show it. recover()
 * already flattens its failures this way (sessionManager recoverSession).
 * Only failures whose text our own code builds from a fixed template cross
 * as themselves: a missing workspace folder (a path the user chose and the
 * pane header already shows; #1324 review A noted it is not secret-free in
 * general, but it reveals nothing the UI does not), a
 * missing provider CLI (names File › Setup…), and this window losing the
 * session. A Claude proxy that would not start becomes its fixed guidance.
 * Everything else is the one safe sentence. Main logs and journals only a
 * fixed signature (classifySpawnFailure), never the text.
 */
function launderSpawnError(
  error: unknown,
  options: Pick<SessionSpawnOptions, 'kind' | 'useProxy'> | undefined,
  journal: AppRunJournal | undefined,
): Error {
  // WHY every read of the thrown value happens exactly once, inside a try,
  // and every return is a FRESH Error built from that one read (#1324 review
  // round 2 A/B): the thrown value is provider-controlled. Converting a
  // non-Error to text runs its toString; an Error's `message` can be a getter
  // that throws, or that answers the fixed window sentence on the first read
  // and a token on the next. Returning the original object let IPC read it
  // again. So nothing of the original crosses except text we compared.
  let failure: SpawnFailure
  try {
    failure = classifySpawnFailure(error, proxyGuidanceApplies(options))
  } catch {
    failure = { signature: 'unreadable-throw', message: SESSION_START_FAILED_MESSAGE }
  }
  // WHY a signature and not the message (#1324 review C): the laundered
  // rejection is all the renderer, the incident journal and a debug bundle
  // ever see, so the one fact that identified the recorded node-pty trap
  // ("posix_spawnp failed") was lost to every artifact this repo debugs
  // from. A fixed code carries that fact and nothing else.
  journal?.record({ area: 'session.spawn', name: 'session.spawn.failed', severity: 'warn', data: { kind: options?.kind ?? null, signature: failure.signature } })
  console.warn('[session:spawn] provider start failed:', failure.signature)
  return new Error(failure.message)
}

/**
 * Only a Claude spawn that runs the proxy gets the proxy guidance (#1324
 * review A/B, round 2 A/B). `useProxy` must be exactly true: that is the
 * test sessionManager uses to start mitmproxy at all, so an omitted value is
 * a launch without a proxy and must not be told to disable one. A Codex
 * spawn whose error mentions mitmdump is not a Claude proxy failure either.
 */
function proxyGuidanceApplies(options: Pick<SessionSpawnOptions, 'kind' | 'useProxy'> | undefined): boolean {
  return options?.kind === 'claude' && options.useProxy === true
}

type SpawnFailure = { signature: string; message: string }

/**
 * Which known failure a spawn rejection is (a fixed code, safe to journal)
 * and the one sentence the renderer may see for it. New signatures go here as
 * they are identified from recorded incidents. Reads `error.message` once;
 * the caller catches a throwing read.
 */
export function classifySpawnFailure(error: unknown, proxyApplies: boolean): SpawnFailure {
  const generic = (signature: string): SpawnFailure => ({ signature, message: SESSION_START_FAILED_MESSAGE })
  if (!(error instanceof Error)) return generic('non-error-throw')
  const raw: unknown = error.message
  if (typeof raw !== 'string') return generic('unreadable-throw')
  // Our own fixed templates cross as themselves: a missing workspace folder
  // (a path the user chose and the pane header already shows; review A noted
  // it is not secret-free in general, but it reveals nothing the UI does not)
  // and a missing provider CLI (names File › Setup…).
  if (error instanceof MissingWorkspaceDirectoryError) return { signature: 'missing-workspace', message: raw }
  if (error instanceof ProviderCliNotFoundError) return { signature: 'cli-not-found', message: raw }
  if (raw === WINDOW_CANNOT_OWN_SESSION) return { signature: 'window-refused', message: WINDOW_CANNOT_OWN_SESSION }
  if (raw.includes('posix_spawnp failed')) return generic('posix-spawnp')
  // The proxy code only where the guidance applies (round 2 B3): a Codex
  // `spawn /repo/mitmdump: ENOENT` is an ENOENT, and signing it claude-proxy
  // would send the next debugger after the wrong subsystem.
  if (proxyApplies && isClaudeProxyStartupFailure(raw)) return { signature: 'claude-proxy', message: CLAUDE_PROXY_STARTUP_FAILED_MESSAGE }
  if (/\bENOENT\b/.test(raw)) return generic('enoent')
  if (/\bEACCES\b/.test(raw)) return generic('eacces')
  return generic('unclassified')
}
