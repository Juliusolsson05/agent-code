import { contextBridge, ipcRenderer } from 'electron'

// Preload bridge — multi-session API.
//
// Every IPC channel is sessionId-scoped because the main process can
// now run N ClaudeSessions in parallel and needs to route messages to
// the right one. The renderer subscribes ONCE per event type and
// dispatches by sessionId in the callback — this avoids N×N listener
// storms as tabs and splits grow.
//
// Legacy note: the pre-tiling API had channels like `pty:screen`,
// `pty:input`, `pty:exit`. Those are all gone. The tile tree uses
// `session:*` channels that carry `{ sessionId, ... }` payloads.

export type JsonlEntry = Record<string, unknown>
export type PickerItem = {
  id: string
  label: string
  description: string
  selected: boolean
}
export type SlashPickerState = {
  visible: boolean
  items: PickerItem[]
}
export type ScreenSnapshot = {
  /** Visible viewport text — what CC's TUI is showing right now.
   *  Source of truth for current-state parsers (trust dialog,
   *  slash picker, activity spinner). */
  plain: string
  /** Viewport with bold/italic re-emitted as markdown. */
  markdown: string
  /** Wider window (last ~200 rows including scrollback) used by
   *  the streaming extractor. CC's responses can grow taller than
   *  the viewport, scrolling the opening `⏺` marker into
   *  scrollback; without this wider snapshot the streaming card
   *  stays blank for long replies. */
  recent: string
  /** Markdown counterpart of `recent`. */
  recentMarkdown: string
  picker: SlashPickerState
}

export type SessionKind = 'claude' | 'codex' | 'terminal'
export type SessionStartedEvent = {
  sessionId: string
  kind: SessionKind
  /** Undefined for terminal sessions — they don't have a CC project dir. */
  projectDir?: string
}
export type SessionScreenEvent = { sessionId: string } & ScreenSnapshot
export type SessionJsonlEntryEvent = {
  sessionId: string
  entry: JsonlEntry
  file: string
}
// Bulk variant used by main during bootstrap bursts. Payload is an
// array of {entry, file} tuples for a single session — the renderer
// folds them in one setState instead of paying one render per entry.
// See main/index.ts jsonl coalescer for the WHY.
export type SessionJsonlEntriesEvent = {
  sessionId: string
  entries: Array<{ entry: JsonlEntry; file: string }>
}
export type SessionJsonlErrorEvent = { sessionId: string; message: string }
/** Raw PTY output for a terminal session — destined for xterm.js. */
export type SessionTerminalDataEvent = { sessionId: string; data: string }
export type SessionTrustDialogEvent = {
  sessionId: string
  visible: boolean
  workspace?: string
}
export type SessionResumePromptEvent = {
  sessionId: string
  visible: boolean
  sessionAgeText?: string
  tokenCountText?: string
  options?: string[]
  selectedIndex?: number
}
export type SessionCompactionStateEvent = {
  sessionId: string
  visible: boolean
  phase?: 'running' | 'error' | 'done'
  statusText?: string
  errorText?: string
}

/** Per-block semantic stream from Claude's proxy adapter (or screen
 *  fallback when proxy is off). `event` is a `SemanticEvent` from
 *  claude-code-headless — discriminated by `event.type` (text_delta /
 *  thinking_delta / tool_input_delta / tool_input_finalized /
 *  block_started / block_completed / turn_started / turn_stopped /
 *  turn_delta / turn_completed / usage_updated / api_error /
 *  stream_error / flow_selected / flow_ignored / source_changed /
 *  tool_result / signature). We keep `event` as unknown at the
 *  preload layer so this bridge doesn't need to pin a version of the
 *  semantic schema — the renderer imports the type from
 *  claude-code-headless and narrows on `event.type`. */
export type SessionSemanticEvent = { sessionId: string; event: unknown }

// --- Session prompt index ---------------------------------------------------
//
// Shape returned by the Search Conversation Prompts modal's IPC
// endpoints. Mirrors src/main/sessionIndex.ts's public exports one-to-
// one; re-declared here because preload/main/renderer are built under
// different tsconfig contexts and we don't share runtime types across
// them by import.
//
// A single entry carries enough metadata for the modal to render a
// row (provider icon, summary, relative time) and show the most
// recent user prompts for visual recognition. `matchCount` is only
// meaningful on search results — zero on the default listing.

export type SessionIndexPrompt = {
  text: string
  ts: number | null
}

export type SessionIndexEntry = {
  providerSessionId: string
  kind: 'claude' | 'codex'
  cwd: string
  lastModified: number
  summary: string
  recentUserPrompts: SessionIndexPrompt[]
  matchCount: number
}

export type SessionHistoryChunk = {
  entries: JsonlEntry[]
  hasMore: boolean
}
export type SessionExitEvent = {
  sessionId: string
  exitCode: number
  signal?: number
}
export type LspSemanticLegend = {
  tokenTypes: string[]
  tokenModifiers: string[]
}
export type LspDiagnostic = {
  message: string
  severity: 'error' | 'warning' | 'info' | 'hint'
  startLine: number
  startCharacter: number
  endLine: number
  endCharacter: number
}
export type LspDiagnosticsEvent = {
  clientUri: string
  diagnostics: LspDiagnostic[]
}

export type SavedClaudeImage = {
  path: string
}

type Unsub = () => void

const lspDiagnosticsSubscribers = new Set<(payload: LspDiagnosticsEvent) => void>()
let lspDiagnosticsListenerInstalled = false

function subscribeLspDiagnostics(cb: (payload: LspDiagnosticsEvent) => void): Unsub {
  lspDiagnosticsSubscribers.add(cb)

  if (!lspDiagnosticsListenerInstalled) {
    lspDiagnosticsListenerInstalled = true
    ipcRenderer.on('lsp:diagnostics', (_evt: unknown, payload: LspDiagnosticsEvent) => {
      for (const subscriber of lspDiagnosticsSubscribers) {
        subscriber(payload)
      }
    })
  }

  return () => {
    lspDiagnosticsSubscribers.delete(cb)
  }
}

/**
 * Helper to register an IPC listener and return an unsubscriber that
 * detaches it. Keeps the api surface below tidy.
 */
function subscribe<T>(channel: string, cb: (payload: T) => void): Unsub {
  const listener = (_evt: unknown, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

export type SessionInfo = {
  sessionId: string
  summary: string
  lastModified: number
  fileSize: number
  customTitle?: string
  firstPrompt?: string
  gitBranch?: string
  cwd?: string
  createdAt?: number
}

const api = {
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
   * Translate the persisted transcript backing a provider session into the
   * other provider's on-disk format and return the newly created target
   * provider session id. The renderer uses that id with replaceSession(...)
   * so the pane stays in place while the backend swaps from Claude<->Codex.
   */
  switchProvider: (params: {
    sourceKind: 'claude' | 'codex'
    sourceProviderSessionId: string
    cwd: string
  }): Promise<{
    targetKind: 'claude' | 'codex'
    targetProviderSessionId: string
    targetFilePath: string
  }> => ipcRenderer.invoke('session:switch-provider', params),

  /**
   * Duplicate a provider session on disk. Reads the source transcript,
   * clones it with a fresh session id (and fresh timestamp for
   * Codex), writes the clone next to the original, and returns the
   * new id. The renderer then passes that id to `spawnSession` /
   * `newTab` with `resumeSessionId: newProviderSessionId` to bring
   * the duplicate online as an independent conversation.
   *
   * Idempotent wrt the source file — the source is untouched. Live
   * sessions can be duplicated; the clone is a point-in-time
   * snapshot (later appends to the live source do not land in it).
   */
  duplicateSession: (params: {
    provider: 'claude' | 'codex'
    sourceProviderSessionId: string
    cwd: string
  }): Promise<{
    provider: 'claude' | 'codex'
    newProviderSessionId: string
    newFilePath: string
  }> => ipcRenderer.invoke('session:duplicate', params),

  /**
   * List the most-recently-active sessions with their last few user
   * prompts attached. Powers the Search Conversation Prompts modal's
   * default (empty-query) view. Results sorted by lastModified desc.
   *
   * cwd === null means "all workspaces"; pass a cwd string to restrict
   * to sessions recorded in that cwd. Defaults: limit=10,
   * promptsPerSession=4.
   */
  listRecentSessionsWithPrompts: (options: {
    limit?: number
    promptsPerSession?: number
    cwd?: string | null
  } = {}): Promise<SessionIndexEntry[]> =>
    ipcRenderer.invoke('sessions:list-recent-with-prompts', options),

  /**
   * Search every session's user prompts for `query` (substring match,
   * case-insensitive). Ranks by match-quality × recency. Returns
   * sessions with their matched prompts prioritised, followed by
   * context prompts from the same session.
   *
   * Empty query degrades to listRecentSessionsWithPrompts.
   */
  searchSessionPrompts: (options: {
    query: string
    limit?: number
    promptsPerSession?: number
    cwd?: string | null
  }): Promise<SessionIndexEntry[]> =>
    ipcRenderer.invoke('sessions:search-prompts', options),

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

  // --- Per-session I/O ---
  sendInput: (sessionId: string, data: string): Promise<boolean> =>
    ipcRenderer.invoke('session:input', sessionId, data),

  resize: (sessionId: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke('session:resize', sessionId, cols, rows),

  // --- Session events (subscribe once; dispatch by sessionId in the callback) ---
  onSessionStarted: (cb: (e: SessionStartedEvent) => void): Unsub =>
    subscribe('session:started', cb),

  onSessionScreen: (cb: (e: SessionScreenEvent) => void): Unsub =>
    subscribe('session:screen', cb),

  onSessionJsonlEntry: (cb: (e: SessionJsonlEntryEvent) => void): Unsub =>
    subscribe('session:jsonl-entry', cb),
  // Bulk: the whole burst from one bootstrap flush, or a single live
  // entry wrapped in a 1-element array. Renderer can treat them
  // identically. See main/index.ts for why the bulk channel exists.
  onSessionJsonlEntries: (cb: (e: SessionJsonlEntriesEvent) => void): Unsub =>
    subscribe('session:jsonl-entries', cb),

  onSessionJsonlError: (cb: (e: SessionJsonlErrorEvent) => void): Unsub =>
    subscribe('session:jsonl-error', cb),

  /** Raw PTY bytes for terminal sessions. Claude sessions do NOT
   *  emit on this channel — they use screen/jsonl-entry instead. */
  onSessionTerminalData: (cb: (e: SessionTerminalDataEvent) => void): Unsub =>
    subscribe('session:terminal-data', cb),

  onSessionProcessState: (
    cb: (e: { sessionId: string; active: boolean; status?: string }) => void,
  ): Unsub => subscribe('session:process-state', cb),

  onSessionTrustDialog: (cb: (e: SessionTrustDialogEvent) => void): Unsub =>
    subscribe('session:trust-dialog', cb),

  onSessionResumePrompt: (cb: (e: SessionResumePromptEvent) => void): Unsub =>
    subscribe('session:resume-prompt', cb),

  onSessionCompactionState: (cb: (e: SessionCompactionStateEvent) => void): Unsub =>
    subscribe('session:compaction-state', cb),

  /** Subscribe to Claude's semantic event stream. Fires for every
   *  SemanticEvent emitted by the adapter — the renderer narrows by
   *  `event.type` and dispatches to the right UI primitive. Called
   *  once at app mount; dispatch by sessionId inside the callback
   *  rather than subscribing per-session. */
  onSessionSemanticEvent: (cb: (e: SessionSemanticEvent) => void): Unsub =>
    subscribe('session:semantic-event', cb),

  onSessionExit: (cb: (e: SessionExitEvent) => void): Unsub =>
    subscribe('session:exit', cb),

  // --- LSP / Monaco code intelligence ---
  ensureLspLegend: (
    workspaceRoot: string,
    language: string,
  ): Promise<LspSemanticLegend | null> =>
    ipcRenderer.invoke('lsp:ensure-legend', workspaceRoot, language),

  openLspDocument: (params: {
    clientUri: string
    content: string
    language: string
    workspaceRoot: string
    filePath?: string | null
  }): Promise<void> => ipcRenderer.invoke('lsp:open-document', params),

  changeLspDocument: (clientUri: string, content: string): Promise<void> =>
    ipcRenderer.invoke('lsp:change-document', clientUri, content),

  closeLspDocument: (clientUri: string): Promise<void> =>
    ipcRenderer.invoke('lsp:close-document', clientUri),

  getLspSemanticTokens: (
    clientUri: string,
  ): Promise<{ data: number[] } | null> =>
    ipcRenderer.invoke('lsp:get-semantic-tokens', clientUri),

  onLspDiagnostics: (cb: (e: LspDiagnosticsEvent) => void): Unsub =>
    subscribeLspDiagnostics(cb),

  // --- Workspace persistence ---
  // Main just does the disk I/O. The renderer decides the JSON shape.
  loadWorkspace: (): Promise<string | null> =>
    ipcRenderer.invoke('workspace:load'),

  saveWorkspace: (json: string): Promise<void> =>
    ipcRenderer.invoke('workspace:save', json),

  defaultCwd: (): Promise<string> =>
    ipcRenderer.invoke('workspace:defaultCwd'),

  // --- Path expansion (used by the new-tab path modal) ---
  expandCwd: (
    raw: string,
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('fs:expandCwd', raw),

  // --- Directory listing (used by PathInput for completion) ---
  // Returns up to ~thousands of entries for a given directory. Renderer
  // filters client-side by the trailing "base" part of the user input.
  listDirectory: (
    rawPath: string,
    opts?: { directoriesOnly?: boolean; showHidden?: boolean },
  ): Promise<
    | {
        ok: true
        entries: Array<{ name: string; isDirectory: boolean; path: string }>
        expanded: string
      }
    | { ok: false; error: string }
  > => ipcRenderer.invoke('fs:listDirectory', rawPath, opts),

  saveClaudeImage: (params: {
    base64Data: string
    mediaType: string
    filename?: string
  }): Promise<SavedClaudeImage> =>
    ipcRenderer.invoke('fs:saveClaudeImage', params),

  // --- Traffic light inset (macOS) ---
  // Main pushes the right-edge X of the traffic light buttons so the
  // tab bar can pad itself dynamically. Zoom-safe, scale-safe.
  onTrafficLightInset: (cb: (insetPx: number) => void): Unsub =>
    subscribe('traffic-light-inset', cb),

  // --- Git info (used by GitBar) ---
  gitStatus: (cwd: string): Promise<
    | {
        ok: true
        branch: string
        files: Array<{ file: string; additions: number; deletions: number }>
        commits: Array<{
          hash: string
          subject: string
          author: string
          relativeDate: string
        }>
        // Submodules with either a bumped pointer, dirty content, or
        // both. Main filters submodule gitlink entries out of `files`
        // so the paths shown here never duplicate parent rows.
        submodules?: Array<{
          path: string
          state: 'dirty' | 'bumped' | 'both'
          files: Array<{ file: string; additions: number; deletions: number }>
          range?: { from: string; to: string }
        }>
      }
    | { ok: false }
  > => ipcRenderer.invoke('git:status', cwd),
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
