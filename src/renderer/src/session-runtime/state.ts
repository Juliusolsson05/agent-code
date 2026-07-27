// -----------------------------------------------------------------------------
// session-runtime/state.ts — the INGEST layer's clean object (#493).
//
// SessionRuntime is the single provider-neutral per-session object that the
// ingest pipeline (channels → reducers in this folder) produces and every
// downstream surface selects from. This file was split out of
// workspace/workspaceState.ts so the layer has one grep-able home; the layout
// types that also lived there (Spotlight/Reader/TileTabs) moved to
// workspace/types.ts — they are tile-tree view state, not runtime.
//
// DEPENDENCY LAW (the reason this folder exists): session-runtime/ must never
// import workspace/, rendering/, features/, app-state/, or react. The pane-UI
// field types below (PickerItem, ClaudeDraftImage, PendingRewindUndo, …) ride
// along here NOT because they are ingest concepts but because SessionRuntime
// embeds them — they are serializable state descriptors, and hoisting them
// out would force this file to import the UI tree, inverting the layer
// direction. The contract for who may read which slice of SessionRuntime is
// declared per consumer (see RuntimeRenderInput for the DECIDE layer's pick),
// not by physically partitioning the type.
// -----------------------------------------------------------------------------

import type { AgentProviderKind } from '@shared/types/providerKind'
import type {
  Entry,
  ToolResultBlock,
  ToolUseBlock,
} from '@shared/types/transcript'
import type { GhostEntry } from 'agent-transcript-parser/ghost'
import type {
  AgentWorkContext,
  WorktreeActivityState,
} from '@shared/work-context/types'
import type { ProviderConditionSnapshot } from '@shared/types/providerConditions'
import type { SessionRecoverFailureCode } from '@shared/types/session'
import type { BuiltInMcpDomain } from '@mcp/shared/types'
import type { SubAgentState } from '@preload/api/types'
export type { SubAgentState, SubAgentToolCall } from '@preload/api/types'

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
  /**
   * Set when no departure ever attributed this item and the session went idle.
   *
   * Claude's queue is provider-owned and `clearCommandQueue()` (ctrl+x ctrl+k)
   * empties it while logging NOTHING, so a residue exists that no reconciler
   * can attribute even in principle. Deleting on a heuristic is the
   * irreversible #159/#290 class; leaving it silently pending is a false claim
   * that work is still queued. Marking is the only option that is neither.
   *
   * Owned exclusively by session-runtime/claudeQueue — the strip renders it and
   * never sets it. Optional because codex/opencode placeholder rows never carry
   * it (their queue is cleared on idle by shouldClearIdleQueuedMessages).
   */
  stale?: boolean
}

export type RenderedViewLeaseFeature =
  | 'copy-assistant-message'
  | 'copy-code-block'

export type ClaudeDraftImage = {
  id: string
  mediaType: string
  base64Data: string
  previewUrl: string
  filename: string
}

export type PromptDeliveryUiState =
  | { kind: 'idle' }
  | { kind: 'sending'; prompt: string; startedAt: number }
  | { kind: 'failed-safe'; message: string }
  | { kind: 'uncertain'; prompt: string; message: string; failedAt: number }

export type PendingRewindUndo = {
  createdAt: number
  provider: AgentProviderKind
  cwd: string
  previousProviderSessionId: string
  rewoundProviderSessionId: string
  rewoundPromptText: string
  rewoundPromptTimestamp: string | null
  previousDraftInput: string
  previousDraftImages: ClaudeDraftImage[]
  builtInMcpDomains?: BuiltInMcpDomain[]
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
// them — the upstream Claude render layer needs them, Agent Code does
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
  /** True when the proxy adapter tagged this assistant turn as
   *  Claude Code's compaction synthesis call (the request body's
   *  last user message matched the fixed compact-prompt signature).
   *  The body that streams back is `<analysis>…</analysis>
   *  <summary>…</summary>` XML, NOT user-visible text — the real
   *  user-facing artefacts are the `compact_boundary` system entry
   *  and the `isCompactSummary: true` user entry that land later
   *  via JSONL. The streaming renderer uses this flag to swap the
   *  raw block stream for a "Compacting conversation…" placeholder.
   *
   *  Defaults missing/false because non-Claude turns (codex, screen
   *  fallback) and pre-2026-05-11 proxy adapters never set it. The
   *  flag is set ONCE at `turn_started`; subsequent events for the
   *  same turn don't carry it (it's a turn-scope attribute, not an
   *  event attribute). */
  isCompactionSynthesis?: boolean
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
  /** The full raw semantic event — captured ONLY when raw capture is on
   *  (semantic/rawCapture.ts, rides AGENT_CODE_DEV_DEBUG). Optional since
   *  #375 part C: retaining every event's full payload in a 200-deep ring
   *  per session was one of the renderer's largest steady-state heap
   *  costs, and the only consumers are dev-debug panels / exported debug
   *  bundles, which degrade gracefully to `summary` when this is absent. */
  raw?: Record<string, unknown>
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
  history: SemanticLiveTurn[]
  flows: Record<string, SemanticFlow>
  errors: SemanticErrorEntry[]
  log: SemanticLogEntry[]
  nextLogId: number
}

export type SessionStatus = 'idle' | 'running' | 'exited'
export type SessionStatusSource = 'none' | 'submit' | 'process' | 'semantic' | 'exit'
export type TranscriptStatus = 'idle' | 'loading' | 'ready' | 'error' | 'disconnected'
export type ProcessStatus = 'idle' | 'spawning' | 'started' | 'failed' | 'exited'

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

export type ProviderSwitchRuntimeState = {
  phase: 'preparing' | 'compacting' | 'summarizing' | 'projecting'
  message: string
}

export type SessionRuntime = {
  screen: string
  screenMarkdown: string
  recentScreen: string
  recentScreenMarkdown: string
  streamingBaseline: string | null
  entries: Entry[]
  /** Total count of JSONL records this session has produced — the
   *  denominator the ScrollIndicator above the composer shows.
   *
   *  WHY this lives separately from `entries.length`:
   *  `entries` is the lazy-load window. It holds the current eager
   *  tail plus whatever older history has been paged in by the
   *  user's upward scroll, capped well below the on-disk total in
   *  long conversations. Reading the indicator off `entries.length`
   *  would make it jitter every time the feed pages old entries in
   *  or out — the exact failure shape that drove #93. `totalEntries`
   *  is "how big is the conversation on disk", which is what the
   *  user actually wants the indicator to answer.
   *
   *  Lifecycle: seeded from `loadInitialHistory.totalEntries` at
   *  initial-load time, then incremented by `appended.length` on
   *  every live `jsonl-entries` IPC burst that produces real new
   *  entries (the `seen` UUID set in useIpcSubscriptions filters
   *  out replay-of-already-known entries, so `appended.length` is
   *  exactly "entries newly committed to disk since we last looked").
   *  Older-history pagination does NOT change this — those entries
   *  were already in the total at resume time. Optimistic user
   *  rows do NOT change this — they are transient UI placeholders;
   *  the real entry's later JSONL append will bump the count.
   *
   *  0 for terminal panes and fresh sessions; the indicator falls
   *  back to a single number when this is 0. */
  totalEntries: number
  awaitingAssistant: boolean
  queuedMessages: QueuedMessage[]
  exited: number | null
  projectDir: string | null
  workContext: AgentWorkContext | null
  workActivity: WorktreeActivityState | null
  picker: SlashPickerState
  conditions: ProviderConditionSnapshot | null
  draftInput: string
  draftImages: ClaudeDraftImage[]
  /**
   * WHY uncertainty survives TileLeaf remounts: a local hook ref disappears
   * when tabs/panes remount and would immediately make an already-written
   * prompt resendable. Runtime is the pane's stable ownership boundary. An
   * uncertain copy is retained for manual recovery, but ordinary Enter is
   * blocked until authoritative transcript activity or an explicit future
   * recovery action resolves it.
   */
  promptDelivery: PromptDeliveryUiState
  /** Ephemeral next-prompt suggestion offered by the model (issue #174).
   *  Lives on the per-session runtime (not a global uiShell slice) because
   *  each pane has its own suggestion and it must survive tab switches.
   *  Set from the `prompt_suggestion` semantic event; cleared when the next
   *  turn starts or the user applies/dismisses it. Never persisted, never
   *  part of the feed/history — that separation is the whole point of #174. */
  promptSuggestion: { text: string; receivedAt: number } | null
  /**
   * WHY this is pane runtime state rather than only a command-level Set: native
   * compaction can run for minutes after the command starts. The composer must
   * remain visibly disabled for that entire transaction or a user prompt can
   * interleave with `/compact` and be mistaken for the portable handoff turn.
   */
  providerSwitch: ProviderSwitchRuntimeState | null
  /** One-shot recovery handle for Rewind to Prompt.
   *
   *  WHY runtime-only: rewind writes a new provider transcript and swaps the
   *  pane to that provider id, but the original provider transcript remains on
   *  disk. The only fragile part is the short-lived user intent: "that rewind
   *  was accidental; put this pane back." Keeping the handle in runtime makes
   *  the affordance local to the live pane and avoids promising durable history
   *  across restart/close, where cwd access, provider transcript existence, and
   *  branch intent all need a larger product contract.
   *
   *  WHY one-shot: after the rewound branch starts a new submit, undoing back to
   *  the old transcript would hide fresh branch work from view. The submit path
   *  clears this field before any provider bytes are written, so the command is
   *  only available while it still means "undo my accidental rewind." */
  pendingRewindUndo: PendingRewindUndo | null
  activityStatus: string | null
  /** Unread marker for list surfaces such as Dispatch Mode.
   *
   *  WHY this lives on the runtime instead of being derived from
   *  entry counts: entries arrive from several sources (semantic
   *  ghosts, JSONL replay, optimistic rows), and replaying history
   *  would make count-based badges lie. The UI only needs a durable
   *  "something happened while you were elsewhere" bit. Focus
   *  actions clear it; IPC writers set it when hidden sessions
   *  receive user-visible output or action-required prompts. */
  unreadSince: number | null
  unreadKind: 'output' | 'attention' | null
  paneToast: string | null
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
  // Monotonic invalidation token for the tool-index maps above (feed audit
  // Finding 1). The maps mutate in place, so their reference identity can NOT
  // tell React context consumers that a cross-entry tool_use↔tool_result
  // pairing changed. Ingest paths bump this whenever `indexEntryIntoMaps`
  // reports a real change; Feed derives its tool-index context value identity
  // from this number so an already-mounted tool-use row (e.g. a GitCardRow
  // waiting on its paired result) repaints when the result lands in a later
  // entry. This is purely a render-invalidation token, not data-model state.
  toolIndexVersion: number
  tailMode: boolean
  /** Runtime-only leases that temporarily request Agent Code's rendered feed.
   *
   * WHY leases instead of a boolean:
   * Hybrid mode is a cooperative contract between independent features. Copy
   * Assistant can need the rendered feed while a future feature also needs it;
   * either feature ending must not snap the pane back to the terminal under
   * the other. A small per-feature ref count mirrors the main-process agent PTY
   * attach count and makes acquire/release balanced without inventing hidden
   * ownership rules.
   *
   * WHY runtime-only:
   * these leases describe active UI affordances, not durable session identity.
   * Persisting them would reopen workspaces into a feature state whose picker,
   * DOM nodes, and keyboard owner no longer exist. */
  renderedViewLeases: Partial<Record<RenderedViewLeaseFeature, number>>
  scrollToLatestRequest: number
  assistantPicker: { selectedUuid: string } | null
  // Copy Code Block picker. Non-null while the "Copy Code Block…"
  // command is active. `selectedId` is a CodeBlock instance id (the
  // `data-code-block-id` attribute the renderer stamps on every
  // CodeBlock root).
  //
  // WHY id-based and not index-based, unlike the obvious "Nth code
  // block" model: the feed streams. Code blocks appear, grow, and
  // re-order while a turn is live, so an index would silently point
  // at a different block between two Up presses. An id stays glued
  // to one block; if that block unmounts the keybind handler snaps
  // to the nearest surviving id (see useKeybinds).
  //
  // WHY this is NOT navigated by a pure workspace action the way
  // assistantPicker is: assistant entries have transcript uuids and
  // `assistantUuidsWithText(entries)` is a pure function of state.
  // Code blocks have no transcript identity — they're nested inside
  // rendered markdown and tool rows. The ordered list only exists in
  // the DOM, so enumeration/navigation lives renderer-side (the
  // copy-code-block feature + useKeybinds); the store only parks the
  // current selection.
  codeBlockPicker: { selectedId: string } | null
  processActive: boolean
  sessionStatus: SessionStatus
  sessionStatusSource: SessionStatusSource
  /** Transcript readiness is deliberately separate from process
   *  readiness. A resumed pane can show durable JSONL history while
   *  the provider TUI is still warming up, and a live process can be
   *  usable even if an optional tail-read failed. */
  transcriptStatus: TranscriptStatus
  transcriptError: string | null
  /** Backend process lifecycle for send gating. `sessionStatus` is
   *  "is the agent doing work right now"; `processStatus` is "does a
   *  writable backend exist for this pane". Keeping them separate
   *  avoids treating an idle, ready agent as unavailable. */
  processStatus: ProcessStatus
  processError: string | null
  /**
   * Typed backend-recovery failure retained only for lifecycle decisions.
   *
   * WHY the human-readable processError is insufficient: an ownership
   * conflict means this renderer explicitly does NOT own the main-process
   * backend under the stable id. Closing that failed pane must therefore not
   * call the ordinary id-only kill API, or it would terminate the unrelated
   * backend recovery correctly refused to adopt. Other failures still own (or
   * may own) their cancelled startup and should use normal teardown.
   */
  recoveryFailureCode: SessionRecoverFailureCode | null
  inputReady: boolean
  /** Last main-owned readiness revision applied to this runtime. -1 means no
   * authoritative snapshot/event has arrived yet. */
  inputReadinessRevision: number
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
  /** Wall-clock ms (epoch) of the newest JSONL entry timestamp we
   *  have observed for this session.
   *
   *  WHY this exists separately from `entries[entries.length-1]`:
   *    Render decisions need a single comparable scalar against
   *    ghost `_atp.updatedAt`. Walking `entries` to find the max
   *    timestamp on every render would be O(N) per call; this is
   *    O(1) read after a single O(burst-size) update at ingest
   *    time. Equally important: the comparison must use entry
   *    *timestamp* (when the producer observed the event), not
   *    `Date.now()`. On resume after a crash the most recent
   *    JSONL entry might be from yesterday but ghost `updatedAt`
   *    is also from yesterday — both sides need to be in the
   *    same wall-clock universe or the comparison flips to
   *    nonsense.
   *
   *  WHY null instead of 0 for "never seen":
   *    A 0-valued sentinel would make `ghost.updatedAt > 0`
   *    always true, accidentally rendering ghosts on a brand-new
   *    session that has produced nothing yet. Null is checked
   *    explicitly in `selectMergedEntries`.
   *
   *  Used by `selectMergedEntries` (./mergedEntries.ts) to decide
   *  whether an orphaned ghost represents JSONL stalling past the
   *  proxy (render — proxy event is the only record) vs. a
   *  sidecar leak Claude Code never logs to its rollout (hide —
   *  JSONL kept writing real turns past it). See
   *  docs/design/ghost-system.md for the canonical explanation of
   *  the predicate this field feeds, and
   *  docs/superpowers/plans/2026-05-07-ghost-system-findings.md
   *  for the long-form diagnostic. */
  lastJsonlEntryAt: number | null
  /** Ghost-record state keyed by ghost uuid (`g-<turnId>-<blockIndex>`).
   *
   *  Ghosts are provisional ClaudeEntry records emitted from the
   *  live semantic reducer to paper over the gap between a
   *  provider's streaming events and its durable JSONL write. See
   *  docs/design/ghost-system.md for the canonical explanation of
   *  the subsystem, `./ghosts.ts` for the reducer functions, and
   *  `agent-transcript-parser/docs/ghost.md` for the underlying
   *  primitive.
   *
   *  The Map is opaque to most code — Feed reads merged entries
   *  via the selector `selectMergedEntries`, and only the ghost
   *  reducer functions mutate this field. Disk persistence lives
   *  in `src/main/ghostJournal.ts`. */
  ghosts: Map<string, GhostEntry>
  /** Task-tool subagents spawned by this session's work, keyed by the parent
   *  `Agent` tool_use id. Folded from the `session:sub-agents` IPC push (which
   *  the main-process watcher derives from `<sessionDir>/subagents/*.jsonl`).
   *  Read by provider spawn rows / SubagentGroupHeader to show how many
   *  agents are running and what each is doing. Empty `{}` when no subagents
   *  exist — the feed then renders exactly as before. */
  subAgents: Record<string, SubAgentState>
}

/**
 * The slice of SessionRuntime the DECIDE layer (rendering/) may read — the
 * declared input contract of issue #493 PR-2.
 *
 * This is a PICK, not a partition: SessionRuntime's other ~50 fields are
 * pane-UI / lifecycle / paging / debug state the ledger must never see.
 * The list is exactly what the pipeline reads today (useLedgerFeedItems'
 * slice assembly + ledgerFeedContextFromRuntime) — nothing speculative.
 * Adding a field here is a CONTRACT change: it licenses the decide layer
 * to depend on it, so it should happen in the same PR as the consumer.
 *
 * WHY a Pick instead of a separate interface SessionRuntime extends:
 * callers pass the SAME runtime object (structural subtype) — no wrapper
 * is ever constructed, so the D11 reference-identity chain (the adapter's
 * per-plane caches key on these exact field references) survives intact.
 * The two former `as unknown as SessionRuntime` casts (remote SessionView,
 * replay's runtimeViewFor) become honestly-typed against this instead.
 */
export type RuntimeRenderInput = Pick<
  SessionRuntime,
  | 'entries'
  | 'semantic'
  | 'streamPhase'
  | 'streamPhasePendingToolName'
  | 'streamPhasePendingToolUseId'
  | 'lastJsonlEntryAt'
> & {
  /** ReadonlyMap, not SessionRuntime's mutable Map: the decide layer only
   *  READS the ghost plane (mutation is the ghost reducer's job, here in
   *  session-runtime). Read-only also lets ghost-less hosts (the phone)
   *  satisfy the contract with a shared frozen empty map. The full runtime's
   *  Map is assignable, so desktop callers still pass `runtime` unchanged. */
  ghosts: ReadonlyMap<string, GhostEntry>
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
    totalEntries: 0,
    awaitingAssistant: false,
    queuedMessages: [],
    exited: null,
    projectDir: null,
    workContext: null,
    workActivity: null,
    picker: { visible: false, items: [] },
    conditions: null,
    draftInput: '',
    draftImages: [],
    promptDelivery: { kind: 'idle' },
    promptSuggestion: null,
    providerSwitch: null,
    pendingRewindUndo: null,
    activityStatus: null,
    unreadSince: null,
    unreadKind: null,
    paneToast: null,
    historyOldestMarker: null,
    hasOlderHistory: false,
    loadingOlderHistory: false,
    bootstrapping: false,
    toolUseIndex: new Map(),
    toolResultIndex: new Map(),
    toolIndexVersion: 0,
    tailMode: false,
    renderedViewLeases: {},
    scrollToLatestRequest: 0,
    assistantPicker: null,
    codeBlockPicker: null,
    processActive: false,
    sessionStatus: 'idle',
    sessionStatusSource: 'none',
    transcriptStatus: 'ready',
    transcriptError: null,
    processStatus: 'idle',
    processError: null,
    recoveryFailureCode: null,
    inputReady: false,
    inputReadinessRevision: -1,
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
    lastJsonlEntryAt: null,
    ghosts: new Map(),
    subAgents: {},
  }
}
