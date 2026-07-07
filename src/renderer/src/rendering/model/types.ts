import type { AgentProviderKind } from '@shared/types/providerKind'

// ---------------------------------------------------------------------------
// Rendering pipeline — the ownership ledger contract.
//
// This is Stage 1 of docs/rendering/rendering-rewrite-plan-2026-07.md. Read
// that plan before changing ANY type here: every field exists because a
// specific production incident required it, and the reason enum is fixture-
// gated (plan §7 rule 15: a reason without a fixture does not merge).
//
// The one invariant (plan §1): every visible feed artifact has exactly one
// owner at a time; every ownership transfer is explicit and evidence-based;
// every rejected candidate keeps its rejection reason; debug output is a
// serialization of the SAME decisions React paints — never a second
// derivation. The months-long bug class this kills: two subsystems both
// believing they own the same visible thing (#172), or an artifact being
// present-but-buried by accidental JSX plane order (#239), or a row
// vanishing with no explanation anywhere (#344).
// ---------------------------------------------------------------------------

/**
 * The candidate kinds — who may paint an artifact. Closed union on purpose:
 * adding an owner is an architectural event that needs plan review, not a
 * convenience. (Plan §1 table for what each owner is allowed to paint.)
 */
export type RenderOwner =
  | 'committed'
  | 'semantic-current'
  | 'semantic-history'
  | 'ghost-fallback'
  | 'optimistic-submit'
  | 'queue'
  | 'work'
  | 'condition'
  | 'empty'
  | 'unknown'

/**
 * Where the evidence came from. Distinct from RenderOwner: a `committed`
 * candidate can arrive via the JSONL plane or opencode's assembled-message
 * plane; a `semantic-current` candidate carries which live stream produced
 * it. Provenance is a TRUST invariant (plan D9): assistant content may only
 * originate from `semantic` with source ∈ {proxy, rollout, opencode-sse} —
 * never `screen`. The fold layer enforces that before candidates exist; the
 * plane here is for evidence/debugging, not re-litigation.
 */
export type RenderSourcePlane =
  | 'committed'
  | 'semantic'
  | 'ghost'
  | 'local-submit'
  | 'queue'
  | 'process'

export type RenderContentKind =
  | 'user-text'
  | 'assistant-text'
  | 'tool-use'
  | 'tool-result'
  | 'thinking'
  | 'image'
  | 'compact-boundary'
  | 'compact-summary'
  | 'work'
  | 'empty'
  | 'unknown'

/**
 * One potential visible unit. BLOCK-level, not turn-level (plan D2): the
 * ownership bugs are unit-granular — Codex commits one response item at a
 * time (#165), committed tool-use must not hide still-live tool output
 * (dump invariant 10), and #194 suppressed by itemId. Turns are a grouping
 * for policy application (Claude's whole-turn suppression is a policy that
 * suppresses all units of a turn), never the ownership atom.
 *
 * Identity fields are deliberately plural: no single id spans providers.
 * Codex proxy uses resp_*, rollout uses turn/task ids, Claude uses
 * message.id == turnId, opencode uses messageId + callID. `id` is the
 * pipeline-stable synthetic identity assigned AT INGEST (plan §6 migration
 * hazards — keys must never fall back to visible index; that produced the
 * React-subtree-reuse "phantom duplicate" class).
 */
export type RenderCandidate = {
  id: string
  owner: RenderOwner
  provider: AgentProviderKind | 'unknown'
  sourcePlane: RenderSourcePlane
  /** Live-stream source when sourcePlane === 'semantic'. */
  source?: string
  sessionId: string
  turnId?: string
  blockIndex?: number
  /** Codex response item id — the #194 suppression key. */
  itemId?: string
  messageId?: string
  /**
   * Reserved as FIRST-CLASS from day one (plan §7 rule 14): the subagent
   * fleet surface (#178/#341) joins parent Task blocks to child state by
   * toolUseId. The ledger schema carrying it now costs nothing; retrofitting
   * it later would touch every candidate collector.
   */
  toolUseId?: string
  callId?: string
  contentKind: RenderContentKind
  /**
   * Per the D4 trust hierarchy: committed entry.timestamp (producer clock)
   * beats semantic startedAt/endedAt (local receipt) beats nothing. Channel
   * receipt `ts` values are diagnostics and MUST NOT land here. Null means
   * "no trustworthy time" and sorts AFTER timestamped content — a missing
   * timestamp is lossy evidence, not proof the row happened last.
   */
  timestampMs: number | null
  /** Stable fallback ordering within equal/absent timestamps. */
  sequence: number
  /** Exact text key for committed-text ownership (never prefix/fuzzy). */
  textKey?: string
  /** NFKC + whitespace-collapsed + trimmed. Conservative by design. */
  normalizedTextKey?: string
  /**
   * Block-grain ownership EVIDENCE mined from a committed entry's content
   * array: every tool_use block id / tool_result tool_use_id inside this
   * entry. Plural because one entry legally carries several parallel tool
   * calls. WHY fields on the entry-grain candidate instead of separate
   * block-grain candidates: committed rows must stay one-per-entry (the
   * view bridge maps candidate → entry item 1:1; block-grain candidates
   * would paint the entry once per block). Ownership sets union these; the
   * corpus proved the gap — with these absent, committed tool ownership
   * was empty for claude and tool cards painted twice (duplicate
   * AskUserQuestion capture, 3 fixtures, two independent triage passes).
   */
  ownedToolUseIds?: readonly string[]
  ownedToolResultIds?: readonly string[]
  /** Tool-use candidates only: the block carries its own result evidence
   *  (resultContent/resultAt landed in the semantic block). Distinguishes
   *  a completed tool row from a permanently-dangling one when no
   *  committed trace exists either (the collapsed-running rule). */
  resolved?: boolean
  /** Tool candidates: the provider tool name (Read, Bash, Task, …). Feeds
   *  the collapsed-running churn-set check and future per-tool row policy. */
  toolName?: string
}

/**
 * Rejection reasons — CLOSED enum, fixture-gated. Every reason here has at
 * least one fixture in testing/fixtures/rendering/ proving when it fires
 * (plan §7 rule 15). If you need a new reason, write the fixture first.
 *
 * `ghost-semantic-owned` carries a death sentence: it exists only because
 * SemanticStreamingTurn still owns the live turn in the legacy renderer.
 * It is deleted at Stage 3 cutover TOGETHER with SemanticStreamingTurn
 * (plan D6 — never one without the other).
 */
export type RenderReason =
  | 'selected'
  | 'committed-text-owned'
  | 'committed-tool-use-owned'
  | 'committed-tool-result-owned'
  | 'claude-whole-turn-suppressed'
  | 'meta-entry'
  | 'synthetic-user-filtered'
  | 'not-conversation'
  | 'ghost-not-orphaned'
  | 'ghost-superseded'
  | 'ghost-semantic-owned'
  | 'ghost-older-than-jsonl'
  | 'ghost-sidecar-shape'
  | 'empty-thinking'
  | 'empty-write-stdin'
  | 'collapsed-running'
  | 'compaction-synthesis'
  | 'optimistic-owned-by-committed'
  | 'queue-owned'
  | 'duplicate-turn-in-history'
  | 'wrong-session-lineage'
  | 'task-notification-joined'
  | 'unknown-hidden'
  | 'unknown-queued-for-implementation'

/**
 * The per-candidate decision record. This IS the debug schema (plan D5):
 * feed-debug and debug bundles serialize these directly, which is what makes
 * "why did this row vanish" answerable from a bundle without archaeology
 * (#344's structural fix). Emitted on first observation, owner change, and
 * suppression.
 */
export type OwnershipDecision = {
  candidateId: string
  selected: boolean
  reason: RenderReason
  /** The candidate that won the slot this one lost. */
  suppressionOwnerId?: string
  /** Id matches, text-hash matches, timestamp comparisons — human-readable. */
  evidence: string[]
}

/**
 * The ordered view model row. React consumes THIS and nothing else at
 * cutover: rows are typed data in, JSX out, zero ownership logic (plan §6).
 * `order` carries its own explanation so a bundle can answer "why is this
 * row here" — sequence is the final sort key; timeMs is diagnostic.
 */
export type RenderRow = {
  candidate: RenderCandidate
  order: {
    sequence: number
    timeMs: number | null
    source: string
  }
}

/**
 * The complete output of one ledger pass. `rows` is what paints; `decisions`
 * covers EVERY candidate (selected and rejected); `unknowns` are structured
 * findings, never silent rows (plan §3 unknown contract).
 *
 * IDENTITY-STABILITY CONTRACT (plan D11 — load-bearing, not an
 * optimization): a ledger pass whose inputs did not change MUST return the
 * previous object by reference. Violating this busts every Feed memo and
 * reintroduced the render-churn defect class twice in production history
 * (2026-04-20 double-RENDER-per-transition; the always-clone ghost maps).
 * The test suite asserts reference equality on no-op for every stage.
 */
export type RenderLedger = {
  rows: readonly RenderRow[]
  decisions: readonly OwnershipDecision[]
  unknowns: readonly UnknownBehavior[]
}

/**
 * Unknown behavior is evidence, not an exception (plan §3). Redaction rules
 * from #115: shape-paths + hashes + short previews only; never full prompt
 * text, tool output, or auth material. `queued_for_implementation` is how
 * future provider behavior is discovered without re-reading bundles.
 */
export type UnknownBehavior = {
  id: string
  provider: AgentProviderKind | 'unknown'
  sourcePlane: RenderSourcePlane
  eventType?: string
  shapePaths: string[]
  payloadHash: string
  redactedPreview?: string
  firstSeenAt: number
  seenCount: number
  disposition:
    | 'queued_for_implementation'
    | 'hidden_unowned'
    | 'hidden_duplicate'
    | 'rendered_fallback_dev_only'
  evidence: string[]
}
