import type { AgentProviderKind } from '@shared/types/providerKind'
import type {
  OwnershipDecision,
  RenderCandidate,
  RenderContentKind,
} from '@renderer/rendering/model/types'

// ---------------------------------------------------------------------------
// Committed candidate collector — the anti-corruption boundary between raw
// transcript entries and the ledger (plan §4 observations/).
//
// Everything downstream consumes candidates, never raw provider shapes.
// Visibility is decided HERE, and hidden entries still produce decision
// records — "was this row hidden because it was meta/synthetic, or never
// ingested?" must be answerable from a bundle (the dump's visibleDecisions
// rationale + #344).
//
// The input type is deliberately STRUCTURAL and narrow: this module owns
// exactly the fields it reads, so provider-type churn (atp upgrades, new
// entry kinds) surfaces here as unknown-shaped input, not as silent
// downstream misbehavior.
// ---------------------------------------------------------------------------

export type RawCommittedEntry = {
  uuid?: string
  type?: string
  isMeta?: boolean
  timestamp?: string | number
  /** Claude-shaped conversation body; opencode's mapper emits this too. */
  message?: {
    id?: string
    role?: string
    content?: unknown
  }
  /** Present on real Claude user prompts; absent on synthetic scaffolding. */
  permissionMode?: string
}

export type CommittedCollection = {
  candidates: RenderCandidate[]
  decisions: OwnershipDecision[]
}

const CONVERSATION_TYPES = new Set(['user', 'assistant'])
const COMPACT_TYPES = new Set(['compact-boundary', 'compact_boundary', 'compact-summary', 'compact_summary'])

/** Claude writes the compaction marker as `type:'system'` with
 *  `subtype:'compact_boundary'` — NOT as a first-class compact type.
 *  Bundle-corpus catch (2026-06-22 c973322e, "did we not have custom
 *  rendering UI for the compaction?"): the legacy renderer painted the
 *  boundary via its VisibleDecision 'compact_boundary' branch while this
 *  collector dropped the row as not-conversation, deleting the compaction
 *  marker from the feed at cutover. */
function isSystemCompactBoundary(e: RawCommittedEntry): boolean {
  return e.type === 'system' && (e as { subtype?: string }).subtype === 'compact_boundary'
}

function entryTimestampMs(e: RawCommittedEntry): number | null {
  // Committed entry.timestamp is the TOP of the trust hierarchy (plan D4) —
  // producer wall-clock. Never substitute Date.now(): resume comparisons
  // (ghost rule 4, ordering across restarts) live in producer time.
  if (typeof e.timestamp === 'number' && Number.isFinite(e.timestamp)) return e.timestamp
  if (typeof e.timestamp === 'string') {
    const ms = Date.parse(e.timestamp)
    return Number.isFinite(ms) ? ms : null
  }
  return null
}

/** Mine block-grain tool ownership evidence from a committed entry's
 *  content array. Claude shape (opencode's mapper emits it too): assistant
 *  entries carry tool_use blocks with `id`; user entries carry tool_result
 *  blocks with `tool_use_id`. Codex rollout entries mapped through the
 *  same shape ride along for free. */
function minedToolIds(e: RawCommittedEntry): {
  toolUse: string[]
  toolResult: string[]
} {
  const toolUse: string[] = []
  const toolResult: string[] = []
  const c = e.message?.content
  if (Array.isArray(c)) {
    for (const b of c) {
      const block = b as { type?: unknown; id?: unknown; tool_use_id?: unknown }
      if (block?.type === 'tool_use' && typeof block.id === 'string') toolUse.push(block.id)
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        toolResult.push(block.tool_use_id)
      }
    }
  }
  return { toolUse, toolResult }
}

function textOf(e: RawCommittedEntry): string | null {
  const c = e.message?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    const first = c.find(
      (b): b is { type: string; text: string } =>
        typeof b === 'object' && b !== null &&
        (b as { type?: unknown }).type === 'text' &&
        typeof (b as { text?: unknown }).text === 'string',
    )
    return first?.text ?? null
  }
  return null
}

/**
 * The #338 synthetic-Claude-user predicate, centralized. Claude writes
 * local-command scaffolding as NON-meta user rows — `<command-name>`,
 * `<local-command-stdout>`, `<environment_context>` — which rendered as if
 * the user typed them ("we are so often spitting out commands into the user
 * prompts"). The stronger predicate already existed in latestUserPrompts.ts
 * and sessionIndex.ts but feed visibility never adopted it; this collector
 * is now the single home. Claude-only: other providers don't emit
 * angle-bracket scaffolding as user rows, and a codex/opencode user message
 * legitimately starting with '<' (pasted HTML) must not be hidden.
 */
function isSyntheticClaudeUserRow(
  e: RawCommittedEntry,
  provider: AgentProviderKind,
): boolean {
  if (provider !== 'claude') return false
  if (e.type !== 'user' || e.message?.role !== 'user') return false
  if (e.permissionMode !== undefined) return false
  const text = textOf(e)
  return typeof text === 'string' && text.trimStart().startsWith('<')
}

function contentKindOf(e: RawCommittedEntry): RenderContentKind {
  if (e.type === 'assistant') return 'assistant-text'
  if (e.type === 'user') return 'user-text'
  if (e.type?.includes('boundary') || isSystemCompactBoundary(e)) return 'compact-boundary'
  return 'compact-summary'
}

// NFKC + whitespace-collapse + trim — the same conservative normalization
// the legacy committedAssistantText sets used. Never fuzzier than this.
export function normalizeTextKey(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

export function collectCommittedCandidates(
  entries: readonly RawCommittedEntry[],
  provider: AgentProviderKind,
  sessionId: string,
): CommittedCollection {
  const candidates: RenderCandidate[] = []
  const decisions: OwnershipDecision[] = []

  entries.forEach((e, index) => {
    // Ingest-time stable id (plan migration hazard: keys must never fall
    // back to visible index — index reuse after order shifts made React
    // retain wrong subtrees, the "phantom duplicate" class). uuid when the
    // provider gave one; otherwise position-at-INGEST, which is stable
    // because the entries array is append-only.
    const id = `entry:${e.uuid ?? `ingest-${index}`}`

    const isConversation = CONVERSATION_TYPES.has(e.type ?? '')
    const isCompact = COMPACT_TYPES.has(e.type ?? '') || isSystemCompactBoundary(e)

    if (!isConversation && !isCompact) {
      decisions.push({ candidateId: id, selected: false, reason: 'not-conversation', evidence: [`type=${e.type ?? 'unknown'}`] })
      return
    }
    if (isConversation && e.isMeta === true) {
      decisions.push({ candidateId: id, selected: false, reason: 'meta-entry', evidence: [] })
      return
    }
    if (isSyntheticClaudeUserRow(e, provider)) {
      decisions.push({
        candidateId: id,
        selected: false,
        reason: 'synthetic-user-filtered',
        evidence: ['claude user row, no permissionMode, text starts with <'],
      })
      return
    }

    const text = textOf(e)
    const mined = minedToolIds(e)
    candidates.push({
      id,
      owner: 'committed',
      provider,
      sourcePlane: 'committed',
      sessionId,
      messageId: e.message?.id,
      turnId: e.message?.id,
      contentKind: contentKindOf(e),
      timestampMs: entryTimestampMs(e),
      sequence: index,
      textKey: e.type === 'assistant' && text ? text : undefined,
      // Assistant rows: both keys, for live-text suppression. User rows:
      // normalized only — NOT for suppression (ownership sets are built from
      // assistant-text candidates exclusively) but for optimistic-prompt
      // reconciliation: the committed user row owns its optimistic stand-in
      // by normalized text (marker+text, never tail position).
      normalizedTextKey: text ? normalizeTextKey(text) : undefined,
      ownedToolUseIds: mined.toolUse.length > 0 ? mined.toolUse : undefined,
      ownedToolResultIds: mined.toolResult.length > 0 ? mined.toolResult : undefined,
    })
    decisions.push({ candidateId: id, selected: true, reason: 'selected', evidence: [] })
  })

  return { candidates, decisions }
}
