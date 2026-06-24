import { ipcRenderer } from 'electron'

import { subscribe } from '@preload/api/ipc.js'
import type {
  SessionExitEvent,
  SessionHistoryChunk,
  SessionInfo,
  SessionJsonlEntriesEvent,
  SessionJsonlErrorEvent,
  SessionAgentPtyDataEvent,
  SessionScreenEvent,
  SessionSemanticEvent,
  SessionStartedEvent,
  SessionTerminalDataEvent,
  SessionConditionsEvent,
  ConditionCustomAction,
  ResolveConditionResult,
  SessionSubAgentsEvent,
  SessionSpawnOptions,
  SessionSpawnResult,
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
  spawnSession: (options: SessionSpawnOptions): Promise<SessionSpawnResult> =>
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
  //
  // Optional `pasteId` correlates this write against the per-paste
  // debug journal in main. When set, main emits a `PTY:main:write`
  // event into `<userData>/paste-debug/<pasteId>.paste.jsonl` so the
  // renderer's `IPC:write:*` events can be paired by `sha8` and byte
  // count. Omit `pasteId` for non-paste writes (keystrokes, agent-pty,
  // etc.) so we don't journal unrelated traffic.
  sendInput: (sessionId: string, data: string, pasteId?: string): Promise<boolean> =>
    ipcRenderer.invoke('session:input', sessionId, data, pasteId),

  resolveCondition: (
    sessionId: string,
    action: ConditionCustomAction,
  ): Promise<ResolveConditionResult> =>
    ipcRenderer.invoke('session:resolveCondition', sessionId, action),

  resize: (sessionId: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke('session:resize', sessionId, cols, rows),

  // Event-driven paste-submit primitive. See
  // src/renderer/.../claudePaste.ts and
  // packages/claude-code-headless/src/ClaudeCodeHeadless.ts.
  // Resolves when Claude's TUI renders `[Pasted text #N]`, or after
  // the configured timeout. Renderer treats every non-'appeared'
  // outcome as "fall through to the wall-clock submit path."
  awaitClaudePastePlaceholder: (
    sessionId: string,
    opts?: { timeoutMs?: number; pollIntervalMs?: number },
  ): Promise<
    | { kind: 'appeared'; waitedMs: number }
    | { kind: 'timeout' }
    | { kind: 'no-headless' }
    | { kind: 'no-session' }
  > =>
    ipcRenderer.invoke('claude:await-paste-placeholder', sessionId, opts),

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

  // The singular `session:jsonl-entry` bridge method was removed: main
  // emits JSONL ONLY through the coalescer as `session:jsonl-entries`
  // (see main/sessions/jsonlCoalescer.ts). A live single entry arrives as
  // a 1-element bulk burst with ~1ms setImmediate latency, so the renderer
  // can treat every JSONL delivery identically. The old singular channel
  // was the pre-coalescer slow path that caused the bootstrap-replay
  // scroll cascade; leaving a dead preload method in place invited new
  // code to resubscribe to a channel main no longer emits, or to revive
  // dual-emit "for compatibility" and reintroduce that bug.
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

  // NOTE: the legacy per-condition listeners (onSessionTrustDialog,
  // onSessionResumePrompt, onSessionPermissionPrompt, onSessionCompactionState)
  // were removed. The renderer consumes a single unified
  // `ProviderConditionSnapshot` through `onSessionConditions` and derives
  // pendingTrustDialog/pendingResumePrompt/pendingPermissionPrompt/
  // pendingCompaction/picker/approval from it (see
  // workspace/hook/ipc/useIpcSubscriptions.ts applyConditionSnapshot).
  // No renderer ever subscribed to the legacy channels; keeping the dead
  // preload methods made it look valid to ingest legacy derived state in
  // parallel with the snapshot, for which there is no documented merge
  // precedence. The manager/provider runtime still emits the granular
  // events internally — deprecating those is owned by the
  // conditions-framework / provider-boundary clusters.
  onSessionConditions: (cb: (e: SessionConditionsEvent) => void): Unsub =>
    subscribe('session:conditions', cb),

  /** Subscribe to per-session subagent fleet state. Fires whenever the
   *  main-process subagents watcher observes a change in any
   *  `<sessionDir>/subagents/agent-<id>.jsonl`. Payload is the full
   *  subAgents map for the session (keyed by parent Agent tool_use id);
   *  the renderer folds it into runtime.subAgents. */
  onSessionSubAgents: (cb: (e: SessionSubAgentsEvent) => void): Unsub =>
    subscribe('session:sub-agents', cb),

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
