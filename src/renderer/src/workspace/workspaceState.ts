import type {
  SessionId,
  SplitDirection,
  TabId,
} from './types'
import type {
  Entry,
  ToolResultBlock,
  ToolUseBlock,
} from '@shared/types/transcript'
import type { GhostEntry } from 'agent-transcript-parser/ghost'

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

export type QueuedMessage = {
  content: string
  timestamp: string
}

export type ClaudeDraftImage = {
  id: string
  mediaType: string
  base64Data: string
  previewUrl: string
  filename: string
}

export type SemanticLiveBlock = {
  blockIndex: number
  kind: string
  text?: string
  thinking?: string
  signature?: string
  citations?: unknown[]
  toolName?: string
  /** Claude's tool call correlation id. Codex uses callId for the
   *  same purpose; both are populated when known so the existing
   *  tool_result pairing logic keeps working regardless of provider. */
  toolUseId?: string
  inputJson?: string
  inputJsonValid?: boolean
  parsedInput?: Record<string, unknown>
  parseError?: string
  finalized?: boolean
  resultContent?: string
  resultIsError?: boolean
  resultAt?: number

  // --- Codex-specific fields from CodexResponsesAdapter -------------------
  //
  // These parallel Claude's tool/reasoning/block fields but follow the
  // OpenAI Responses API shape. All are optional — a Claude-sourced
  // block leaves them undefined. A Codex-sourced block populates the
  // ones that apply to its ResponseItem variant (function_call,
  // web_search_call, image_generation_call, local_shell_call, etc.).

  /** Codex's upstream item identifier (`msg_…`, `rs_…`, `fc_…`). Stable
   *  for the life of the block; pairs SSE deltas with the enclosing
   *  item on both the proxy and rollout paths. */
  itemId?: string
  /** Codex's tool-call correlation id (equivalent to toolUseId for
   *  Claude). Kept as a separate field because both can co-exist on a
   *  block if a Claude tool_use is remapped through a Codex proxy
   *  layer in the future. */
  callId?: string
  /** Message phase when upstream emits one: `"commentary"` for mid-turn
   *  progress narration, `"final_answer"` for the terminal reply.
   *  undefined on older models that don't emit the field. See
   *  codex-rs/protocol/src/models.rs:170-184. */
  messagePhase?: 'commentary' | 'final_answer'
  /** Free-form upstream status string (`"in_progress"`, `"completed"`,
   *  provider-specific failure states). */
  status?: string
  /** Raw JSON string for a function_call's arguments. Kept alongside
   *  `parsedInput` so a renderer can show either the raw text (for
   *  debugging / copy) or the parsed object (for pretty display). */
  argumentsJson?: string
  /** Tool call output payload from function_call_output /
   *  custom_tool_call_output. May be a plain string or a structured
   *  content array — preserve as `unknown` and let the renderer
   *  narrow. */
  output?: unknown
  /** Web search action payload (search/open_page/find_in_page). */
  webSearchAction?: {
    kind: 'search' | 'open_page' | 'find_in_page' | 'other'
    query?: string
    queries?: string[]
    url?: string
    pattern?: string
  }
  /** Image generation call payload. `result` is base64-encoded. */
  imageGeneration?: {
    status: string
    revisedPrompt?: string
    result: string
  }
  /** Local shell exec call payload (sandboxed shell invocations). */
  localShellCall?: {
    status: string
    command: string[]
    workingDirectory?: string
    timeoutMs?: number
    env?: Record<string, string>
    user?: string
  }
  /** Reasoning block accumulators — `summary` is the user-facing digest
   *  (reasoning_summary_text deltas); `full` is the detailed chain-of-
   *  thought (reasoning_text deltas). ChatGPT delivers reasoning
   *  encrypted, so both may be empty strings while the raw
   *  `encrypted_content` lives on the ResponseItem. */
  reasoningSummary?: string
  reasoningText?: string
}

export type SemanticTodoItem = {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm: string
}

export type SemanticTaskSnapshot = {
  todos: SemanticTodoItem[]
  doneCount: number
  totalCount: number
  inProgressToolUseIds: string[]
  activeToolNames: string[]
}

export type SemanticToolCallSnapshot = {
  toolUseId: string
  blockIndex: number
  kind: string
  toolName: string | null
  status: 'in_progress' | 'completed' | 'error'
  inputJson: string
  resultContent: string | null
}

// Per-turn tool-call index. Kept intentionally minimal: only fields
// consumed by a rendered surface live here. Two fields (hasParseError,
// siblingToolUseIds) were removed after confirming no reader used
// them — the upstream Claude render layer needs them, cc-shell does
// not yet. Add back only when a real caller appears.
export type SemanticLookupSnapshot = {
  toolCallsById: Record<string, SemanticToolCallSnapshot>
  toolUseIdsInOrder: string[]
  resolvedToolUseIds: string[]
  erroredToolUseIds: string[]
}

export type SemanticLiveTurn = {
  turnId: string
  text: string
  source: string | null
  blocks: Record<number, SemanticLiveBlock>
  blockOrder: number[]
  stopReason: string | null
  usage: Record<string, number | string | undefined> | null
  task: SemanticTaskSnapshot
  lookups: SemanticLookupSnapshot
  startedAt: number
  endedAt: number | null
}

export type SemanticFlow = {
  flowId: string
  attribution: 'active' | 'secondary' | 'candidate' | 'ignored'
  reason: string
  turnId: string | null
  firstSeen: number
  lastSeen: number
  bytesEstimate: number
  chunkCount: number
}

export type SemanticLogEntry = {
  id: number
  type: string
  ts: number
  summary: string
  raw: Record<string, unknown>
}

export type SemanticErrorEntry = {
  ts: number
  kind: 'api_error' | 'stream_error'
  message: string
}

export type FeedDebugLayer = 'STATE' | 'JSONL' | 'SEM' | 'RENDER' | 'GHOST'

export type FeedDebugEntry = {
  id: number
  ts: number
  tMs: number
  layer: FeedDebugLayer
  kind: string
  summary: string
  data?: unknown
}

export type SemanticRuntimeState = {
  currentTurn: SemanticLiveTurn | null
  history: Array<Pick<SemanticLiveTurn, 'turnId' | 'text' | 'stopReason' | 'startedAt' | 'endedAt'>>
  flows: Record<string, SemanticFlow>
  errors: SemanticErrorEntry[]
  log: SemanticLogEntry[]
  nextLogId: number
}

export type SessionStatus = 'idle' | 'running' | 'exited'
export type SessionStatusSource = 'none' | 'submit' | 'process' | 'semantic' | 'exit'

/** In-feed "what is the agent doing" phase. Mirrors the upstream
 *  Claude Code `streamMode` vocabulary so the WorkIndicator reads a
 *  single field regardless of provider. Derived in the headless
 *  package (ClaudeProxyAdapter / CodexResponsesAdapter) from SSE
 *  events; the renderer never re-derives. See
 *  `docs/superpowers/plans/2026-04-18-thinking-phase-in-headless.md`
 *  for the full derivation table. */
export type StreamPhase =
  | 'idle'
  | 'submitting'
  | 'requesting'
  | 'thinking'
  | 'responding'
  | 'tool-input'
  | 'tool-use'
  | 'awaiting-tool'

export type SessionRuntime = {
  screen: string
  screenMarkdown: string
  recentScreen: string
  recentScreenMarkdown: string
  streamingBaseline: string | null
  entries: Entry[]
  awaitingAssistant: boolean
  queuedMessages: QueuedMessage[]
  exited: number | null
  projectDir: string | null
  picker: SlashPickerState
  draftInput: string
  draftImages: ClaudeDraftImage[]
  activityStatus: string | null
  paneToast: string | null
  pendingApproval: {
    callId: string | null
    command: string[]
    workdir: string | null
    reason?: string | null
    options?: string[]
    selectedIndex?: number
  } | null
  pendingTrustDialog: {
    workspace?: string
  } | null
  pendingResumePrompt: {
    sessionAgeText?: string
    tokenCountText?: string
    options?: string[]
    selectedIndex?: number
  } | null
  pendingCompaction: {
    phase: 'running' | 'error' | 'done'
    statusText?: string
    errorText?: string
  } | null
  historyOldestMarker: string | null
  hasOlderHistory: boolean
  loadingOlderHistory: boolean
  // True while a bulk bootstrap burst is being delivered — set when
  // the first batched jsonl-entries event lands, cleared after a
  // short quiet window. Feed suspends auto-scroll and lazy-mount
  // cascades while this is true; a single pin-to-bottom runs on the
  // transition back to false. WHY a boolean: a one-shot phase is
  // simpler than a counter because we don't need to track overlapping
  // bursts — setImmediate on main guarantees one flush per tick.
  bootstrapping: boolean
  // Incremental tool_use/tool_result indices, keyed by tool_use_id.
  // Maintained at entry-ingest time so Feed doesn't rebuild them via
  // useMemo([entries]) on every append — that used to be O(N²) during
  // bootstrap (200 entries × O(N) rebuild per render × 200 renders).
  // Maps are mutated in place; the runtime object reference changes
  // each append, which is fine because Feed reads the maps by
  // reference through context, not by shallow compare.
  toolUseIndex: Map<string, ToolUseBlock>
  toolResultIndex: Map<string, ToolResultBlock>
  tailMode: boolean
  scrollToLatestRequest: number
  assistantPicker: { selectedUuid: string } | null
  processActive: boolean
  sessionStatus: SessionStatus
  sessionStatusSource: SessionStatusSource
  semantic: SemanticRuntimeState
  /** Current in-feed stream phase. Set by the `stream_phase` reducer
   *  case from SemanticStreamPhaseEvent; additionally set by the
   *  optimistic-submit path ('submitting') and by tool_result arrival
   *  (clears pending tool if it matches). The WorkIndicator is the
   *  only consumer today; everything else reads the existing
   *  sessionStatus. */
  streamPhase: StreamPhase
  /** Tool name for phases that carry one (tool-input / tool-use /
   *  awaiting-tool). null otherwise. */
  streamPhasePendingToolName: string | null
  /** Tool use id for pending-tool phases. Matched against incoming
   *  tool_result events to transition out of `awaiting-tool`. */
  streamPhasePendingToolUseId: string | null
  /** Wall-clock timestamp of the current turn's first non-idle phase.
   *  Reset to null when phase returns to idle. WorkIndicator's
   *  elapsed-time counter derives from this. */
  turnStartedAt: number | null
  /** Wall-clock timestamp of the last phase transition. Separate from
   *  turnStartedAt so the UI can show per-phase elapsed (e.g.
   *  "Thinking · 3s" vs "Calling Read · 8s" within the same turn). */
  phaseChangedAt: number | null
  /** Wall-clock timestamp the user hit submit. Set by the optimistic-
   *  submit path (setStreamingBaseline) so 'submitting' has a start
   *  time before the adapter's first 'requesting' event arrives. */
  submittedAt: number | null
  /** Pane-focused feed/render debug stream. This is not raw transport
   *  logging — it tracks the operations that changed what the pane
   *  actually shows, plus the resolved visible-row list emitted by
   *  Feed. */
  feedDebugLog: FeedDebugEntry[]
  feedDebugNextId: number
  feedDebugEpochMs: number | null
  /** Ghost-record state keyed by ghost uuid (`g-<turnId>-<blockIndex>`).
   *
   *  Ghosts are provisional ClaudeEntry records emitted from the
   *  live semantic reducer to paper over the gap between a
   *  provider's streaming events and its durable JSONL write. See
   *  `./ghosts.ts` for the reducer and
   *  `agent-transcript-parser/docs/ghost.md` for the underlying
   *  primitive.
   *
   *  The Map is opaque to most code — Feed reads merged entries via
   *  the selector `selectMergedEntries`, and only the ghost reducer
   *  functions mutate this field. The in-memory shape is the only
   *  source of truth for Phase 1; Phase 2 adds disk persistence in
   *  `src/main/ghostJournal.ts` for crash recovery. */
  ghosts: Map<string, GhostEntry>
}

export function emptySemanticRuntime(): SemanticRuntimeState {
  return {
    currentTurn: null,
    history: [],
    flows: {},
    errors: [],
    log: [],
    nextLogId: 1,
  }
}

export function parseSemanticTodos(
  parsedInput: Record<string, unknown> | undefined,
): SemanticTodoItem[] {
  const raw = Array.isArray(parsedInput?.todos) ? parsedInput.todos : []
  return raw.map(item => {
    const todo = (item ?? {}) as Record<string, unknown>
    const status =
      todo.status === 'in_progress' || todo.status === 'completed'
        ? todo.status
        : 'pending'
    return {
      content: typeof todo.content === 'string' ? todo.content : '',
      status,
      activeForm: typeof todo.activeForm === 'string' ? todo.activeForm : '',
    }
  })
}

export function emptyRuntime(): SessionRuntime {
  return {
    screen: '',
    screenMarkdown: '',
    recentScreen: '',
    recentScreenMarkdown: '',
    streamingBaseline: null,
    entries: [],
    awaitingAssistant: false,
    queuedMessages: [],
    exited: null,
    projectDir: null,
    picker: { visible: false, items: [] },
    draftInput: '',
    draftImages: [],
    activityStatus: null,
    paneToast: null,
    pendingApproval: null,
    pendingTrustDialog: null,
    pendingResumePrompt: null,
    pendingCompaction: null,
    historyOldestMarker: null,
    hasOlderHistory: false,
    loadingOlderHistory: false,
    bootstrapping: false,
    toolUseIndex: new Map(),
    toolResultIndex: new Map(),
    tailMode: false,
    scrollToLatestRequest: 0,
    assistantPicker: null,
    processActive: false,
    sessionStatus: 'idle',
    sessionStatusSource: 'none',
    semantic: emptySemanticRuntime(),
    streamPhase: 'idle',
    streamPhasePendingToolName: null,
    streamPhasePendingToolUseId: null,
    turnStartedAt: null,
    phaseChangedAt: null,
    submittedAt: null,
    feedDebugLog: [],
    feedDebugNextId: 1,
    feedDebugEpochMs: null,
    ghosts: new Map(),
  }
}

export type SpotlightState = {
  tabId: TabId
  focusedSessionId: SessionId
}

export type ReaderModeState = {
  tabId: TabId
  focusedSessionId: SessionId
}

export type TileTabsState = {
  tabIds: TabId[]
  focusedTabId: TabId
  direction: SplitDirection
  ratios: number[]
}
