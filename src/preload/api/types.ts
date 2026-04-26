// Shared payload types for the preload IPC bridge.
//
// These are declared once here so every domain module (and the
// renderer) imports the same shape. Types that are specific to a
// single domain (LSP diagnostics, git response) can live beside
// their methods — keep this file for types that cross domain
// boundaries or are referenced from the outside.
//
// Keeping Unsub here too: every onX subscriber returns one, and the
// generic subscribe helper in ./ipc.ts produces them.

export type Unsub = () => void

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
/** Raw PTY output for an attached Claude/Codex inline terminal. */
export type SessionAgentPtyDataEvent = { sessionId: string; data: string }
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
export type SessionPermissionPromptEvent = {
  sessionId: string
  visible: boolean
  title?: string
  toolName?: string
  command?: string
  options?: Array<{ key: string; label: string }>
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

export type FeedDebugPersistEntry = {
  id: number
  ts: number
  tMs: number
  layer: 'STATE' | 'JSONL' | 'SEM' | 'RENDER'
  kind: string
  summary: string
  data?: unknown
}

// Debug bundle — opaque file list shipped from renderer to main.
// See main/storage/debugBundle.ts for the layout rationale. Types
// are duplicated here (not imported) because preload/main/renderer
// build under different tsconfig contexts, same convention as
// SessionIndexEntry above.
export type DebugBundleFile = {
  name: string
  content: string
}
export type SaveDebugBundleParams = {
  sessionId: string
  files: DebugBundleFile[]
}
export type SaveDebugBundleResult = {
  bundlePath: string
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

export type WorktreeActivityCounts = {
  reads: number
  writes: number
  commands: number
  commits: number
  pushes: number
  verifications: number
}

export type WorktreeActivitySummary = {
  worktreePath: string
  branch: string | null
  lastActivityAt: number
  lastProvider: 'claude' | 'codex'
  lastProviderSessionId: string
  lastTranscriptFile: string
  lastSource: string
  score: number
  eventCounts: WorktreeActivityCounts
}

export type WorktreeActivityIndexStatus = {
  lastIndexedAt: number | null
  refreshing: boolean
  stale: boolean
  cacheHits: number
  parsedFiles: number
  skippedFiles: number
}
