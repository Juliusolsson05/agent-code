import { ipcRenderer } from 'electron'

import { subscribe } from '@preload/api/ipc.js'
import type {
  SessionExitEvent,
  SessionHistoryChunk,
  SessionInfo,
  SessionJsonlEntriesEvent,
  SessionJsonlEntryEvent,
  SessionJsonlErrorEvent,
  SessionPermissionPromptEvent,
  SessionAgentPtyDataEvent,
  SessionKind,
  SessionScreenEvent,
  SessionSemanticEvent,
  SessionStartedEvent,
  SessionTerminalDataEvent,
  SessionTrustDialogEvent,
  SessionResumePromptEvent,
  SessionCompactionStateEvent,
  SessionConditionsEvent,
  TranscriptPathRequest,
  TranscriptPathResult,
  Unsub,
} from '@preload/api/types.js'

// Session lifecycle + I/O bridge methods.
//
// Every channel is sessionId-scoped because the main process can run
// N ClaudeSession / CodexSession / TerminalSession instances in
// parallel and needs to route messages to the right one. The renderer
// subscribes ONCE per event type and dispatches by sessionId in the
// callback — this avoids N×N listener storms as tabs and splits grow.

export const sessionApi = {
  // --- Session lifecycle ---
  spawnSession: (options: {
    /** Optional. Defaults to 'claude' on the main side so existing
     *  callers don't need to change. Pass 'terminal' to spawn a
     *  plain shell session instead. */
    kind?: SessionKind
    cwd: string
    cols?: number
    rows?: number
    resumeSessionId?: string
    dangerousMode?: boolean
    /** Claude only. Opt into proxy-driven semantic streaming. When
     *  true, the session spawns a per-session mitmproxy, streams
     *  decrypted Anthropic events through it, and the renderer gets
     *  per-block semantic events via `onSessionSemanticEvent`. Needs
     *  mitmproxy installed (see claude-code-headless/PROXY_STREAMING.md).
     *  Default false — session behavior is unchanged. */
    useProxy?: boolean
    /** Terminal + tmux only: when set AND tmux is available, attach
     *  to this existing tmux session instead of creating a new one.
     *  Used by the workspace reload path to recover persistent
     *  terminals. Falls back to fresh spawn if the session no longer
     *  exists. */
    recoverTmuxName?: string
  }): Promise<{ sessionId: string; tmuxName?: string }> =>
    ipcRenderer.invoke('session:spawn', options),

  killSession: (sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke('session:kill', sessionId),

  /**
   * Attach this renderer to a terminal session's live data stream.
   * Returns the full buffered output so far — every byte the shell
   * has written since spawn. Main flips the session's attached flag
   * atomically so subsequent PTY data broadcasts live via
   * 'session:terminal-data'.
   *
   * The renderer must subscribe to 'session:terminal-data' BEFORE
   * calling this, then queue any live events it receives until the
   * attach response arrives — otherwise events between subscribe
   * and attach response are silently missed. See TerminalLeaf.tsx
   * for the queue pattern.
   */
  attachTerminal: (sessionId: string): Promise<string> =>
    ipcRenderer.invoke('session:terminal-attach', sessionId),

  /**
   * Attach this renderer to a Claude/Codex session's raw PTY terminal.
   * Returns a capped replay buffer and enables live
   * 'session:agent-pty-data' events for the session. Used by
   * DebugPanel's inline terminal view;
   * normal agent panes continue to render from screen/jsonl/semantic
   * state and do not subscribe to this high-volume byte stream.
   */
  attachAgentPty: (sessionId: string): Promise<string> =>
    ipcRenderer.invoke('session:agent-pty-attach', sessionId),

  detachAgentPty: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke('session:agent-pty-detach', sessionId),

  // --- Per-session I/O ---
  sendInput: (sessionId: string, data: string): Promise<boolean> =>
    ipcRenderer.invoke('session:input', sessionId, data),

  resize: (sessionId: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke('session:resize', sessionId, cols, rows),

  // --- Resume picker: list previous sessions recorded in a cwd ---
  listSessionsForCwd: (
    cwd: string,
    limit?: number,
    provider: 'claude' | 'codex' = 'claude',
  ): Promise<SessionInfo[]> =>
    ipcRenderer.invoke('session:list-for-cwd', cwd, limit, provider),

  /** Global session listing for the rendering-debug harness. Returns
   *  every known Claude + Codex session tagged with provider, sorted
   *  by lastModified desc. */
  listAllSessions: (
    limit?: number,
  ): Promise<Array<SessionInfo & { provider: 'claude' | 'codex' }>> =>
    ipcRenderer.invoke('session:list-all', limit),

  loadOlderHistory: (params: {
    kind: 'claude' | 'codex'
    cwd: string
    providerSessionId: string
    beforeMarker: string
    limit?: number
  }): Promise<SessionHistoryChunk> =>
    ipcRenderer.invoke('session:load-older-history', params),

  loadInitialHistory: (params: {
    kind: 'claude' | 'codex'
    cwd: string
    providerSessionId: string
    limit?: number
  }): Promise<SessionHistoryChunk> =>
    ipcRenderer.invoke('session:load-initial-history', params),

  resolveTranscriptPaths: (
    requests: TranscriptPathRequest[],
  ): Promise<TranscriptPathResult[]> =>
    ipcRenderer.invoke('session:resolve-transcript-paths', requests),

  // --- Session events (subscribe once; dispatch by sessionId in the callback) ---
  onSessionStarted: (cb: (e: SessionStartedEvent) => void): Unsub =>
    subscribe('session:started', cb),

  onSessionScreen: (cb: (e: SessionScreenEvent) => void): Unsub =>
    subscribe('session:screen', cb),

  onSessionJsonlEntry: (cb: (e: SessionJsonlEntryEvent) => void): Unsub =>
    subscribe('session:jsonl-entry', cb),
  // Bulk: the whole burst from one bootstrap flush, or a single live
  // entry wrapped in a 1-element array. Renderer can treat them
  // identically. See main/sessions/jsonlCoalescer.ts for why the
  // bulk channel exists.
  onSessionJsonlEntries: (cb: (e: SessionJsonlEntriesEvent) => void): Unsub =>
    subscribe('session:jsonl-entries', cb),

  onSessionJsonlError: (cb: (e: SessionJsonlErrorEvent) => void): Unsub =>
    subscribe('session:jsonl-error', cb),

  /** Raw PTY bytes for terminal sessions. Claude sessions do NOT
   *  emit on this channel — they use screen/jsonl-entry instead. */
  onSessionTerminalData: (cb: (e: SessionTerminalDataEvent) => void): Unsub =>
    subscribe('session:terminal-data', cb),

  /** Raw PTY bytes for attached Claude/Codex inline terminals. */
  onSessionAgentPtyData: (cb: (e: SessionAgentPtyDataEvent) => void): Unsub =>
    subscribe('session:agent-pty-data', cb),

  onSessionProcessState: (
    cb: (e: { sessionId: string; active: boolean; status?: string }) => void,
  ): Unsub => subscribe('session:process-state', cb),

  onSessionTrustDialog: (cb: (e: SessionTrustDialogEvent) => void): Unsub =>
    subscribe('session:trust-dialog', cb),

  onSessionResumePrompt: (cb: (e: SessionResumePromptEvent) => void): Unsub =>
    subscribe('session:resume-prompt', cb),

  onSessionPermissionPrompt: (cb: (e: SessionPermissionPromptEvent) => void): Unsub =>
    subscribe('session:permission-prompt', cb),

  onSessionCompactionState: (cb: (e: SessionCompactionStateEvent) => void): Unsub =>
    subscribe('session:compaction-state', cb),

  onSessionConditions: (cb: (e: SessionConditionsEvent) => void): Unsub =>
    subscribe('session:conditions', cb),

  /** Subscribe to Claude's semantic event stream. Fires for every
   *  SemanticEvent emitted by the adapter — the renderer narrows by
   *  `event.type` and dispatches to the right UI primitive. Called
   *  once at app mount; dispatch by sessionId inside the callback
   *  rather than subscribing per-session. */
  onSessionSemanticEvent: (cb: (e: SessionSemanticEvent) => void): Unsub =>
    subscribe('session:semantic-event', cb),

  onSessionExit: (cb: (e: SessionExitEvent) => void): Unsub =>
    subscribe('session:exit', cb),
}
