// ProviderConfig — split into renderer-safe and main-process parts.
//
// The renderer bundle can't import Node modules (node-pty, chokidar,
// fs). The main process can't import React components. So the config
// is two interfaces, each with its own registry. Hard split — there
// is NO combined `ProviderConfig` type. A previous version of this
// file exported one, and also shipped `providers/<kind>/config.ts`
// files that implemented it by importing both `ClaudeSession`
// (Node-only) and `TileLeaf` (React-only). That was the bridge that
// caused the node tsconfig to walk into renderer files and emit the
// JSX-not-set cascade across ~500 lines of error output. Both halves
// and their registries are now strictly separate; `registry.main.ts`
// builds MainProviderConfig, `registry.renderer.ts` builds
// RendererProviderConfig, and nothing re-joins them.

import type { ComponentType, ReactNode } from 'react'
import type { SessionOptions, SessionInfo, AgentSession } from '@shared/types/session.js'
import type { AgentProviderKind } from '@shared/types/providerKind.js'
import type { Entry, ToolResultBlock, ToolUseBlock } from '@shared/types/transcript.js'

/**
 * Provider operation routing is deliberately explicit about all three
 * outcomes. `undefined` and React's `null` used to double as an unwritten
 * protocol between separate tool-use and tool-result dispatch calls; that
 * made an innocent refactor capable of deleting a result row. Providers now
 * decide the correlated pair together and every hidden result names the card
 * that preserves its evidence.
 */
export type ProviderSpecializedReceipt = {
  rendererId: string
  protocolId?: string
}

export type ProviderVisibleDecision =
  | { action: 'render'; node: ReactNode; receipt: ProviderSpecializedReceipt }
  | { action: 'fallback' }

export type ProviderResultDecision =
  | ProviderVisibleDecision
  | {
      action: 'absorb'
      ownerRenderId: string
      protocolId?: string
      reason: string
    }

export type ProviderOperationInput = {
  toolUse: ToolUseBlock
  result: ToolResultBlock | null
  live: boolean
  streaming: boolean
  /**
   * The semantic source has closed this invocation even when it emitted no
   * result payload. This is intentionally distinct from `!streaming`: durable
   * replay also passes streaming=false for an invocation whose result may be
   * missing, so deriving completion from that flag would invent lifecycle.
   */
  finalized?: boolean
}

export type ProviderOperationDecision = {
  /** Invocation absorption is rare (for example an empty continuation poll)
   * but must still be named rather than hidden inside a React component. */
  toolUse: ProviderResultDecision
  /** Null is legal only while the correlated result does not exist yet. */
  toolResult: ProviderResultDecision | null
}

/**
 * A live semantic block uses the same explicit ownership vocabulary as a
 * durable operation. Keeping one decision algebra is important: semantic
 * rendering used to return ReactNode, where both "declined" and "claimed but
 * intentionally hidden" could collapse to nullish values and the evidence
 * observer then invented a provider-wide receipt. The decision now carries
 * the exact renderer/protocol that actually admitted the block.
 */
export type ProviderSemanticDecision = ProviderResultDecision

export type ProviderDurableEntryInput = { entry: Entry }
/**
 * Admission result for provider-authored entries that are not ordinary
 * conversation rows. This is deliberately a tiny semantic model instead of
 * the provider's raw discriminator: the ownership ledger needs to know that a
 * durable row exists and how it orders, but it must not learn that Claude uses
 * `system.subtype` while another provider may use a different carrier.
 */
export type ProviderDurableEntryKind =
  | 'compact-boundary'
  | 'compact-summary'
  | 'queued-user-prompt'
export type ProviderDurableEntryDecision = Extract<
  ProviderVisibleDecision,
  { action: 'render' }
>

/** Provider-decoded completion carrier made available to correlated operation
 * rows. The shell transports this closed presentation model but never parses
 * a provider's source envelope. Claude currently fills it from durable
 * <task-notification> entries; providers without that protocol return no map. */
export type ProviderTaskNotification = {
  taskId: string | null
  toolUseId: string | null
  status: string | null
  summary: string | null
  result: string | null
  outputFile: string | null
  usage: string | null
}

export type TileLeafRelatedAgentTab = {
  sessionId: string
  relation: 'parent' | 'linked' | 'orchestration'
  label: string
  title: string
  kind: AgentProviderKind | 'terminal' | undefined
  placement: 'grid' | 'detached'
}

// Props the shell passes to every provider's TileLeaf.
export type TileLeafProps = {
  sessionId: string
  runtime: unknown
  focused: boolean
  paneLabel?: string
  onFocusRequest: () => void
  workspace: unknown
  showStatusMode?: boolean
  showWorktreeBadges?: boolean
  /**
   * WHY these shell-chrome props live in the provider contract now:
   * TileTree has always passed them to the concrete in-repo TileLeaf, but the
   * public type claimed providers only received the bare pane identity/runtime
   * fields. That mismatch forced TileTree to widen the component with a local
   * cast, which hid the real call surface from any future provider pane.
   *
   * Keep the shapes structural and renderer-free here on purpose. Importing
   * `Workspace`, `SessionId`, or `GridRelatedAgentTab` from the renderer would
   * make this shared type drag renderer files into the node project again, the
   * exact boundary leak this file exists to prevent. The concrete renderer
   * types are assignable to these strings/records without coupling the halves.
   */
  ownerSessionId?: string
  relatedAgentTabs?: TileLeafRelatedAgentTab[]
  selectedRelatedSessionId?: string
  onSelectRelatedSession?: (sessionId: string) => void
}

/**
 * The shared provider config intentionally does not import `ConditionView`.
 *
 * WHY the value type is `unknown`: this file is imported by both node and
 * renderer projects to describe the provider registry shape. The actual
 * condition view contract is React-renderer-only and is enforced in
 * `registry.renderer.capabilities.ts`, where importing ConditionView is safe.
 * Keeping this shared boundary opaque prevents a provider capability from
 * pulling renderer condition modules into the main-process type graph again.
 */
export type RendererConditionViewRegistry = Record<string, unknown>

// ---------------------------------------------------------------------------
// Transcript-entry mapping capability (#394 phase 2b)
// ---------------------------------------------------------------------------

/**
 * Result of mapping ONE raw transcript line (Claude JSONL entry or
 * Codex rollout line) into feed entries.
 *
 * `entries` may be empty (Claude lines filtered by the conversation/
 * compact gate; Codex event_msg lines with no feed representation) or
 * carry multiple entries (Codex response_items that fan out).
 *
 * `historyMarker` is the provider's pagination marker for this line —
 * Claude: stable uuid (null for non-conversation lines); Codex:
 * synthesized timestamp:id marker (always present). Call sites own the
 * policy for WHEN to record it (bootstrap records the first, older-
 * pagination replaces conditionally).
 */
export type MappedTranscriptEntry = {
  entries: import('@shared/types/transcript.js').Entry[]
  historyMarker: string | null
}

/**
 * Provider-owned transcript-line mapper. Created fresh per ingestion
 * stream (one per live session, one per history chunk, one per
 * preview build).
 *
 * WHY an interface with a factory instead of a pure function: Codex's
 * mapping is stateful — a rolling turn cursor stamps entries with the
 * turn they belong to, updated/cleared by lines the mapper itself
 * sees. Claude's mapper is stateless and implements the cursor
 * methods as no-ops. The live-ingest site persists the cursor across
 * bursts via get/setTurnCursor; chunk-scoped sites just discard the
 * mapper.
 *
 * This capability is what killed the quadruplicated per-provider
 * mapping loops (live ingest / initial history / older history /
 * preview — see #394 §4.5, §9). A third provider implements ONE
 * mapper and every ingestion path picks it up from the registry.
 */
export type TranscriptEntryMapper = {
  map(raw: Record<string, unknown>): MappedTranscriptEntry
  getTurnCursor(): string | null
  setTurnCursor(id: string | null): void
}

// ---------------------------------------------------------------------------
// Semantic fold policy (opencode rendering pipeline fix, 2026-07-06)
// ---------------------------------------------------------------------------

/**
 * Per-provider turn-ownership policy for the renderer's semantic reducer
 * (`session-runtime/semantic/foldEvent.ts`).
 *
 * WHY this exists: foldSemanticEvent used to hard-gate turn replacement and
 * block soft-open on `sessionKind === 'codex'` / `'claude'` literals at five
 * sites. Any third provider silently fell into Codex's STRICT path — but
 * Codex's recovery hatches only fire for `ev.source === 'proxy'`, and
 * opencode's single event stream is `source: 'opencode-sse'`. Net effect in
 * the 2026-07-06 debug bundle: 200 semantic events folded into 1 committed
 * entry — every block/turn event that mismatched the stale live turn was
 * dropped with no recovery hatch ever applying. The literals were the bug;
 * this policy is the provider-owned replacement (same move as
 * `conditionPolicy` replacing hardcoded kind lists in phase 3 of #394).
 *
 * The type lives HERE (shared, import-light) rather than in
 * registry.renderer.capabilities.ts so provider policy files and the fold
 * reducer can both import it without touching the registry's React imports.
 * It is pure data — no functions — so exact per-provider semantics stay
 * readable at the registration site.
 *
 * Semantics (see foldEvent.ts `canReplaceMismatchedTurn` for the one
 * evaluator; an ENDED current turn is replaceable for every provider —
 * that's a sequential handoff, not a race):
 */
export type SemanticFoldPolicy = {
  /**
   * turn_started / turn_delta / tool_started carrying a DIFFERENT turnId
   * than the live current turn: archive-and-replace unconditionally.
   * Claude: true — its next assistant message legitimately mints a fresh
   * msg_id while a cross-turn tool_result keeps the old turn pinned;
   * dropping it would hide every subsequent Claude turn. Codex/opencode:
   * false — replacement goes through the source-trust rules below.
   */
  autoReplaceOnTurnMismatch: boolean
  /**
   * Sources allowed to soft-open a brand-new turn from a stray
   * block_started when NO current turn exists. Codex: ['proxy'] (the
   * 2026-05-16 lost-turn-opener recovery). OpenCode: ['opencode-sse'] —
   * headless currently keys tool blocks on sessionID while text rides
   * messageID, so a tool block can be the first event of a turn the
   * renderer ever sees; hard-dropping it loses the whole tool row.
   * Claude: [] — resurrecting archived turns from late blocks is a known
   * older failure mode there.
   */
  softOpenTurnFromBlockSources: readonly string[]
  /**
   * Whether a mismatched block_started may replace the current turn at
   * all (subject to canReplaceMismatchedTurn). Codex/opencode: true.
   * Claude: false — bit-preserves the old `sessionKind === 'codex'` gate
   * where Claude always dropped mismatched blocks, even onto ended turns.
   */
  canReplaceTurnFromBlock: boolean
  /**
   * Sources trusted to claim ownership of a mismatched LIVE (unended)
   * turn. Untrusted sources only ever replace ended turns. Codex:
   * ['proxy'] (render-critical stream vs screen/rollout fallback).
   * OpenCode: ['opencode-sse'] — its ONLY stream, server-authoritative.
   */
  trustedReplaceSources: readonly string[]
  /**
   * When a trusted source mismatches a live turn: true = replace outright
   * (structured opencode — exactly one event stream, no PTY/proxy dual-source
   * flicker, so a new turnId from that stream is always a legitimate new
   * turn); false = only through the completed/empty yield hatches
   * (codex — two racing producers make an outright replace re-create the
   * 0/1/0/1 semantic row flicker).
   */
  allowReplaceOfLiveTurn: boolean
}

/**
 * Renderer-side config: only browser-safe imports.
 * Imported by TileTree, workspaceStore, etc.
 */
export type RendererProviderConfig = {
  /** Provider identity — constrained to the shared source of truth so a
   *  config can't be registered under an id the rest of the app doesn't
   *  recognise. */
  id: AgentProviderKind
  name: string
  /**
   * Provider-owned condition views.
   *
   * WHY this belongs on the renderer registry: the snapshot already carries a
   * provider id, and unknown providers should flow through the same throwing
   * registry lookup as panes. The old `provider === 'claude' ? A : B` in
   * ProviderConditionOutlet silently rendered every future provider with Codex
   * views. Keeping the views here makes the provider registry load-bearing for
   * one real renderer capability instead of another ad hoc binary fallback.
   */
  conditionViews: RendererConditionViewRegistry
  /** Provider-owned interpretation of one correlated tool operation. */
  renderOperation: (input: ProviderOperationInput) => ProviderOperationDecision
  /** Provider-only durable rows such as Claude/Codex compaction artifacts. */
  renderDurableEntry?: (
    input: ProviderDurableEntryInput,
  ) => ProviderDurableEntryDecision | undefined
  /** The pane component the shell mounts inside TileTree. */
  TileLeaf: ComponentType<TileLeafProps>
}

/**
 * Main-process config: Node-only imports (session factories, fs).
 * Imported by sessionManager, IPC handlers.
 */
export type PersonalAgentSkillLocation = {
  id: string
  resolveDirectory: (context: {
    homeDirectory: string
    environment: Readonly<Record<string, string | undefined>>
  }) => string
}

export type MainProviderConfig = {
  /** Provider identity — see RendererProviderConfig.id. */
  id: AgentProviderKind
  name: string
  /**
   * Provider-owned discovery capability for native personal Agent Skills.
   *
   * WHY paths live here while writes do not: providers own where their runtime
   * discovers skills, but one app service must own collision checks, journaling,
   * and deletion proof. Putting filesystem mutation callbacks on each provider
   * would duplicate the safety state machine and make “all providers” an
   * untestable set of side effects.
   */
  personalAgentSkills:
    | { supported: true; locations: readonly PersonalAgentSkillLocation[] }
    | { supported: false; reason: string }
  /**
   * Factory: create a new session instance for this provider.
   *
   * WHY the return is typed AgentSession (and not `unknown` as
   * before): the previous shape made every provider silently
   * responsible for matching an unwritten event/method contract.
   * sessionManager.spawn then cast to a structural AgentSessionLike
   * that only checked "can subscribe" — a provider that dropped
   * `screen`, misspelled `semantic-event`, or shipped a different
   * payload for `jsonl-entry` compiled fine and failed silently at
   * runtime as "the feature is just missing" (a top failure mode in
   * #394 §4).
   *
   * See @shared/types/session.ts for the AgentSession contract
   * (typed event map + optional capability methods). Widening for a
   * third provider now surfaces as a compile error inside the
   * provider, exactly where it can be fixed.
   */
  createSession: (opts: SessionOptions) => AgentSession
  /**
   * Optional native-terminal execution for the same provider identity.
   *
   * WHY this is a second factory rather than a second provider registry row:
   * setup, skills, MCP permissions, history identity, and binary resolution
   * all remain provider-level concerns. Only providers with a real interactive
   * TUI expose this capability; SessionManager rejects a requested terminal
   * runtime when the selected provider does not implement it.
   */
  createTerminalSession?: (opts: SessionOptions) => AgentSession
  /** List resumable sessions for a cwd. */
  listSessions: (cwd: string, limit: number) => Promise<SessionInfo[]>
  /** A placeholder list must not be advertised as a complete empty catalog. */
  sessionDiscoveryUnavailableReason?: string
  /**
   * List resumable sessions without cwd scoping when a caller genuinely needs a
   * global debug/resume inventory.
   *
   * WHY this is optional and provider-owned: the normal app flow should prefer
   * `listSessions(cwd, limit)` so resume choices match the cwd Agent Code will
   * spawn in. The rendering-debug harness is different: it has no focused cwd
   * and needs a cross-provider inventory. Routing that exceptional path through
   * the main provider registry prevents IPC adapters from importing provider
   * storage walkers directly while still allowing Claude to keep its app-local
   * global walker until the package grows an equivalent API.
   */
  listAllSessions?: (limit: number) => Promise<SessionInfo[]>
  /** Resolve the on-disk project dir for a cwd. */
  getProjectDir: (cwd: string) => Promise<string>
  /**
   * Resolve the durable transcript file for a provider session id.
   *
   * WHY this is separate from getProjectDir: Claude's project dir is the
   * transcript directory itself, while Codex's "project dir" equivalent is a
   * global sessions root that must be searched by structured rollout filename.
   * Returning a path-level helper from the provider registry keeps shared
   * history loading from knowing which meaning each provider assigned to
   * `getProjectDir`.
   */
  resolveTranscriptPath: (cwd: string, providerSessionId: string) => Promise<string | null>
  /**
   * Provider-owned prompt delivery protocol (#394 phase 2c).
   *
   * WHY this is a capability and not inline branches: prompt delivery
   * disciplines are OPPOSITE between the two shipped providers —
   * Codex gates on TUI readiness BEFORE pasting and sends paste+Enter
   * as one atomic PTY write (its headless accounts the prompt as
   * submitted on the paste bytes); Claude pastes WITHOUT Enter, waits
   * for the `[Pasted text #N]` placeholder to prove the paste
   * committed, then sends Enter separately. The old inline
   * `if codex … if claude …` in MCP's submitPrompt meant a THIRD
   * provider fell through to a protocol-free paste+Enter with no
   * readiness gate and no confirmation (#394 §4.2) — it "worked"
   * exactly until it didn't, silently.
   *
   * The io bag deliberately passes the AgentSession plus a bound
   * write-with-liveness function rather than the SessionManager:
   * providers must not depend on the manager (dependency arrow), and
   * the typed optionals they need (awaitReadyForPrompt /
   * awaitPastePlaceholder) live on AgentSession since phase 2a.
   */
  deliverPrompt: (io: PromptDeliveryIo) => Promise<PromptDeliveryResult>
}

export type PromptDeliveryIo = {
  session: AgentSession
  /** Write raw bytes to the session PTY. Returns false when the
   *  session is gone — callers already treat that as delivery
   *  failure, so providers just propagate it. */
  write: (data: string) => boolean
  sessionId: string
  prompt: string
  /** Prepared local attachment paths. Only Claude desktop supplies these;
   * saving happens before main reserves/writes so filesystem failure remains
   * cleanly retry-safe. */
  imagePaths?: string[]
  /** Non-blocking forensic sink. Correctness must never await or depend on it. */
  record?: (event: string, data?: Record<string, unknown>) => void
}

export type PromptAcceptance =
  | { kind: 'user'; acceptedAt: number; entryId?: string }
  | { kind: 'queue'; acceptedAt: number }
  | { kind: 'transport'; acceptedAt: number }

export type PromptDeliveryFailureStage =
  | 'reservation'
  | 'before-write'
  | 'absorption'
  | 'after-enter'
  | 'session-exit'

export type PromptDeliveryFailureCode =
  | 'delivery-in-flight'
  | 'missing-capability'
  | 'not-ready'
  | 'write-failed'
  | 'absorption-timeout'
  | 'acceptance-timeout'
  | 'session-exited'
  | 'transport-failed'

/**
 * What the caller may do with the session after delivery fails. This is
 * intentionally independent from `retrySafe`: duplicate safety answers whether
 * the prompt may be attempted again, while disposition answers whether this
 * particular child is still healthy enough to keep.
 */
export type PromptDeliveryDisposition =
  | 'retry-same-session'
  | 'retry-after-resolve'
  | 'do-not-retry'
  | 'session-unusable'

/**
 * Finished-prompt delivery result.
 *
 * WHY this is richer than the old `{ok,message}` boolean: once prompt bytes or
 * Enter have reached a PTY, retrying is no longer automatically safe. The old
 * shape forced every caller to treat an uncertain post-write timeout like a
 * clean pre-write rejection, which is how a delayed first attempt became two
 * duplicate Claude queue entries in the July 11 production failure.
 */
export type PromptDeliveryResult =
  | { ok: true; acceptance: PromptAcceptance }
  | {
      ok: false
      stage: PromptDeliveryFailureStage
      code: PromptDeliveryFailureCode
      message: string
      retrySafe: boolean
      disposition: PromptDeliveryDisposition
      promptWritten: boolean
      enterWritten: boolean
    }

// The combined `ProviderConfig = RendererProviderConfig & MainProviderConfig`
// type used to live here. It was only ever used by
// `providers/<kind>/config.ts` files that implemented the full
// surface, which forced those files to import BOTH TileLeaf (React)
// AND ClaudeSession (Node). That cross-boundary import was the
// source of the renderer-in-node tsc cascade. Type removed; use the
// one-sided types above.
