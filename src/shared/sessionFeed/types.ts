import type { ProviderConditionSnapshot } from '@shared/types/providerConditions.js'
import type { SessionKind } from '@shared/types/providerKind.js'
import type { AgentTranscriptEntry } from '@shared/types/session.js'

// Session-feed wire types — the payload shapes that cross the SessionFeed
// contract (see ./SessionFeed.ts).
//
// WHY these live in @shared and not @preload/api/types (their historical
// home): the SessionFeed contract must be implementable by surfaces that
// have no Electron at all — the remote mobile client implements it over a
// WebSocket (see docs/superpowers/specs/2026-07-06-remote-mobile-companion-
// design.md). @shared is the only layer importable by renderer, main, AND
// the future remote client without dragging in `electron` or the preload
// bridge. The declarations were MOVED here (not duplicated); preload
// re-exports them so every existing `@preload/api/types` import keeps
// resolving byte-for-byte — the same pattern providerConditions.ts uses
// for conditions-core.
//
// WHY the semantic `event` stays `unknown`: this boundary is deliberately
// provider-agnostic. Pinning one provider's SemanticEvent schema here would
// couple every SessionFeed transport to that provider's version; consumers
// narrow on `event.type` instead (see the original rationale on
// SessionSemanticEvent, carried over from the preload declaration).

export type Unsub = () => void

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

export type SessionStartedEvent = {
  sessionId: string
  kind: SessionKind
  /** Undefined for terminal sessions — they don't have a CC project dir. */
  projectDir?: string
}

export type SessionScreenEvent = { sessionId: string } & ScreenSnapshot

// Bulk variant used by main during bootstrap bursts. Payload is an
// array of {entry, file} tuples for a single session — the renderer
// folds them in one setState instead of paying one render per entry.
// See main/sessions/jsonlCoalescer.ts for the WHY. Uses the neutral
// AgentTranscriptEntry directly; preload's `JsonlEntry` alias of the
// same type remains at the preload boundary for its other consumers.
export type SessionJsonlEntriesEvent = {
  sessionId: string
  entries: Array<{ entry: AgentTranscriptEntry; file: string }>
}

export type SessionJsonlErrorEvent = { sessionId: string; message: string }

export type SessionConditionsEvent = {
  sessionId: string
  snapshot: ProviderConditionSnapshot
}

/** Provider process activity. Previously an inline literal at every
 *  consumer; named here because the SessionFeed contract needs a
 *  nominal type both transports can reference. */
export type SessionProcessStateEvent = {
  sessionId: string
  active: boolean
  status?: string
}

// --- Subagent fleet -----------------------------------------------------------
//
// Claude Code's `Agent` tool spawns a subagent whose FULL transcript is written
// live to `<projectDir>/<providerSessionId>/subagents/agent-<id>.jsonl`, with a
// sidecar `agent-<id>.meta.json` carrying { agentType, description, toolUseId }.
// `toolUseId` matches the parent `Agent` tool_use block id exactly — the
// deterministic join key that lets the feed nest a subagent's live work under
// the card that spawned it. The main-process watcher derives these and pushes
// the whole per-session map on every change. See src/main/subagents/ and
// docs/superpowers/specs/2026-06-14-subagent-fleet-rendering-design.md.

/** One tool call in a subagent's timeline (the drill-in mini-feed). */
export type SubAgentToolCall = {
  /** Tool name, e.g. "Read" | "Bash" | "Grep". */
  name: string
  /** First meaningful arg (path/command/pattern/query), already truncated. */
  headline: string | null
  /** 'done' once a matching tool_result was observed; else 'running'. */
  status: 'running' | 'done'
}

/** Live state of one subagent, keyed by its parent `Agent` tool_use id. */
export type SubAgentState = {
  /** Parent `Agent` tool_use block id — meta.toolUseId. The render join key. */
  toolUseId: string
  /** The agent-<id> filename id. */
  agentId: string
  /** meta.agentType, e.g. "Explore" | "general-purpose". */
  agentType: string
  /** meta.description — the card headline. */
  description: string
  /** 'stale' = still nominally running but no transcript activity for the
   *  staleness window (#341): the child died / hung without a terminal
   *  signal. Distinct from 'done' on purpose — we don't fabricate
   *  completion; the row shows a "gone quiet" treatment instead of an
   *  eternal spinner. */
  status: 'running' | 'done' | 'error' | 'stale'
  /** Epoch ms of the first transcript entry, or null if unknown. */
  startedAt: number | null
  /** Epoch ms of the last observed entry (drives elapsed + live pulse). */
  lastActivityAt: number | null
  /** Count of assistant turns observed. */
  turnCount: number
  /** Ordered tool-call timeline (capped — see SUBAGENT_TOOL_CALLS_MAX). */
  toolCalls: SubAgentToolCall[]
  /** Count of tool calls dropped from the front when capped (0 if none). */
  droppedToolCalls: number
  /** Derived activity label, e.g. "running Grep" | "thinking" | null. */
  currentActivity: string | null
}

/** Per-session push: the full subAgents map for one session, keyed by
 *  parent `Agent` tool_use id. */
export type SessionSubAgentsEvent = {
  sessionId: string
  subAgents: Record<string, SubAgentState>
}

/** Per-block semantic stream from an agent provider — Claude AND Codex:
 *  Claude via its proxy adapter (or screen fallback when proxy is off),
 *  Codex via its rollout/proxy adapter. `event` is a provider
 *  `SemanticEvent` discriminated by `event.type` (text_delta /
 *  thinking_delta / tool_input_delta / tool_input_finalized /
 *  block_started / block_completed / turn_started / turn_stopped /
 *  turn_delta / turn_completed / usage_updated / api_error /
 *  stream_error / flow_selected / flow_ignored / source_changed /
 *  tool_result / signature). Kept `unknown` ON PURPOSE — see the module
 *  comment above. */
export type SessionSemanticEvent = { sessionId: string; event: unknown }

export type SessionExitEvent = {
  sessionId: string
  exitCode: number
  signal?: number
}

export type ResolveConditionResult =
  | { ok: true; state?: unknown }
  | {
      ok: false
      reason:
        | 'timeout'
        | 'aborted'
        | 'invalid-payload'
        | 'option-not-found'
        | 'no-session'
        | 'no-headless'
        | 'no-resolver'
      lastState?: unknown
      failedAtStep?: string
    }

// The custom-action wire primitive already lives with the conditions
// framework — re-export rather than move so conditions-core stays the
// single source of truth.
export type { ConditionCustomAction } from '@shared/conditions-core/contract.js'
