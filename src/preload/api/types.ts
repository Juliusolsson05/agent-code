import type { ProviderConditionSnapshot } from '@shared/types/providerConditions.js'
export type { ProviderConditionSnapshot } from '@shared/types/providerConditions.js'

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

export type DictationProvider = 'deepgram' | 'assemblyai' | 'openai' | 'gladia' | 'elevenlabs'

export type DictationStartResult =
  | { kind: 'started'; id: string }
  | { kind: 'error'; message: string }

export type DictationStopResult =
  | {
      kind: 'success'
      raw: string
      text: string
      provider: 'deepgram'
      audioBytes: number
      chunkCount: number
      sttMs: number
    }
  | { kind: 'no-speech' }
  | { kind: 'error'; message: string }

export type DictationHotkeyConfigureResult =
  | { ok: true; binding: string; native: boolean }
  | { ok: false; binding: string; native: boolean; message?: string }

export type DictationStreamTranscriptEvent = {
  id: string
  text: string
  isFinal: boolean
  source: 'final' | 'interim'
}

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

export type SessionConditionsEvent = {
  sessionId: string
  snapshot: ProviderConditionSnapshot
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

export type TranscriptPathRequest = {
  sessionId: string
  kind: 'claude' | 'codex'
  cwd: string
  providerSessionId: string
}

export type TranscriptPathResult = TranscriptPathRequest & {
  transcriptPath: string | null
  exists: boolean
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
  layer: 'STATE' | 'JSONL' | 'SEM' | 'RENDER' | 'GHOST'
  kind: string
  summary: string
  data?: unknown
}

// Dictation per-session debug dump.
//
// Every dictation press writes one append-only JSONL file under
// `<userData>/dictation-debug/<debugSessionId>.dictation.jsonl`. Both
// renderer and main emit events through `window.api.recordDictationDebugEvent`
// (fire-and-forget); main batches them at 100 ms per file. See
// `src/main/dictationJournal.ts` for the on-disk layout and
// `src/main/ipc/dictation.ts` for the privacy invariants this surface is
// required to honour (never log raw audio bytes, never log API keys,
// transcript text IS in the file because the file is local user-private).
//
// WHY `debugSessionId` is renderer-minted and NOT the Deepgram stream id:
//   The Deepgram `streamId` is null for the first ~180 ms of every press
//   because we queue chunks locally to discard accidental taps before
//   opening the provider socket. Keying the debug file on the streamId
//   would lose every startup event — exactly the window where the
//   "sine-wave dead / live preview missing" symptoms originate. Minting
//   our own UUID at recorder construction time gives the file a stable
//   key from the first emitted event onward.
export type DictationDebugLayer =
  | 'META'        // session lifecycle: created, recorder-config, final outcome
  | 'DEVICE'      // mic enumeration, getUserMedia result, granted track labels
  | 'RECORDER'    // MediaRecorder lifecycle: start, error, stop, dataavailable
  | 'CHUNK'       // per-chunk audit across renderer + main, with sha8 + size
  | 'AUDIO_LEVEL' // 7-band analyser samples (the sine-wave data), ~10 Hz
  | 'IPC'         // every renderer↔main round-trip with id + result kind
  | 'PROVIDER'    // streaming WS trace + batch upload trace (deepgram only)
  | 'TRANSCRIPT'  // every live preview callback + final committed text
  | 'OUTCOME'     // success / no-speech / error / cancel — terminal event
  | 'ERROR'       // anything that throws / rejects

export type DictationDebugEventInput = {
  layer: DictationDebugLayer
  event: string
  data?: Record<string, unknown>
}

// On-disk form. `tMs` is stamped main-side from the journal's anchor
// (first event = t=0); callers pass DictationDebugEventInput.
export type DictationDebugEvent = DictationDebugEventInput & {
  ts: number   // wall clock, Date.now()
  tMs: number  // monotonic offset from session start
}

// Per-paste debug dump.
//
// Direct mirror of the dictation-debug subsystem. Every Enter that
// triggers cc-shell's paste-submit code path writes one append-only
// JSONL file under `<userData>/paste-debug/<pasteId>.paste.jsonl`
// capturing the full renderer→IPC→main→PTY chain. The bug we are
// chasing is the "paste in cc-shell needs a second Enter to submit"
// intermittent — the PTY-isolated harness at
// `vendor/in_progress/paste-submit-repro/` shows the production
// 125 ms timer path works at 10/10 in isolation, so the failure must
// be somewhere the harness doesn't model (renderer keyboard handler,
// IPC queue, React state, double-submit race). This dump is the
// diagnostic tool that will pin it down.
//
// `pasteId` is renderer-minted at the moment Enter is observed in the
// composer keydown handler, BEFORE any state mutation or async send
// happens. Threading it through the call stack lets the main side's
// PTY-write event correlate against the renderer's keydown timestamp
// for the same press — same pattern dictation uses to pair
// `CHUNK:renderer:produced` against `CHUNK:main:received` by sha8.
//
// Privacy contract is identical to dictation-debug: never log API
// keys, never log raw PTY bytes — log byte count + sha8 fingerprint
// instead. Composer text head IS logged (truncated to 240 chars)
// because the file is local 0o600 and the whole point is to see
// what the user actually pasted vs. what reached Claude.
export type PasteDebugLayer =
  | 'RENDER'   // composer keydown, state snapshot, call into claudePaste fn
  | 'IPC'      // renderer-side IPC write (paste payload, submit \r)
  | 'PTY'      // main-side PTY write (sha8 + byte count) — pairs with IPC
  | 'SCREEN'   // [Pasted text #N] placeholder observed to appear / clear
  | 'OUTCOME'  // composer cleared / still-stuck / explicit cancel — terminal
  | 'ERROR'

export type PasteDebugEventInput = {
  layer: PasteDebugLayer
  event: string
  data?: Record<string, unknown>
}

export type PasteDebugEvent = PasteDebugEventInput & {
  ts: number
  tMs: number
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

// Section of a debug bundle filled by readProxyEvents IPC.
// Carries the renderer-readable form of whatever
// ~/.config/cc-shell/proxy/<project>/<session>/<run>/proxy-events.jsonl
// existed for the target session at bundle-save time. Nulls signal
// "no record found" — callers must tolerate them. See
// main/storage/proxyEventsReader.ts for the search strategy and
// PROXY_EVENTS_BUNDLE_MAX_BYTES tail cap.
export type ProxyEventsBundleSection = {
  proxyEvents: string | null
  runDir: string | null
  sessionMeta: string | null
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
