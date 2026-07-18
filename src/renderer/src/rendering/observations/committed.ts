import type { AgentProviderKind } from '@shared/types/providerKind'
import type {
  OwnershipDecision,
  RenderCandidate,
  RenderContentKind,
} from '@renderer/rendering/model/types'
// Value import (not a type): the SAME provider capability the fleet row uses
// to decide which tool_use becomes a spawn card. Reusing it here keeps
// the join-suppression set tied to the exact blocks that CONSUME a
// notification — if the two ever diverged, we'd either suppress a standalone
// row nobody re-renders (lost background result) or double-paint one.
import {
  isAgentSpawnTool,
  providerDurableEntryKind,
  providerTaskNotificationFromEntry,
} from '@providers/registry.renderer.capabilities'
import type { Entry, ToolUseBlock } from '@shared/types/transcript'
import type { ProviderDurableEntryKind } from '@shared/types/providerConfig'

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
  /**
   * Provider classifiers receive the intact entry object through the registry.
   * Keep provider-only keys structurally available without naming them here:
   * naming `subtype`/`isCompactSummary` in this shared collector would turn a
   * transport boundary back into a second provider vocabulary parser.
   */
  [key: string]: unknown
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
  /** Claude tags a SUBAGENT's own turns isSidechain:true and interleaves them
   *  into the PARENT transcript (issue #477). Their activity already renders
   *  inside the Task card via the watcher channel (SubAgentState), so painting
   *  them as main-feed rows is pure duplication. The field flows through the
   *  claude codec + history.ts; the feed just never honored it (only the
   *  session picker did). */
  isSidechain?: boolean
}

export type CommittedCollection = {
  candidates: RenderCandidate[]
  decisions: OwnershipDecision[]
}

const CONVERSATION_TYPES = new Set(['user', 'assistant'])
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

/**
 * Pre-scan for the P2b join-suppression: the committed tool_use ids of
 * subagent-SPAWN blocks (claude `Agent`, codex `spawn_agent`, the MCP
 * orchestration forms — but only when the active provider's adapter validates
 * the complete spawn input).
 *
 * WHY this set exists — the row-double-render this closes: a
 * `<task-notification>` is the spawn's OWN completion report, and
 * the provider spawn row ALREADY paints it inside the parent card via
 * `notifications.get(spawnBlock.id)` (see Feed's taskNotifications map,
 * keyed by the notification's <tool-use-id>). If this collector ALSO selects
 * the standalone notification entry as a user row, the identical background
 * result renders twice — once joined into the Task card, once as a lone
 * bubble. Legacy killed exactly this in the now-deleted deriveFeedRenderModel
 * via `committedToolUseIndex.has(notification.toolUseId)`; the ledger has to
 * reinstate it or the corruption returns at cutover.
 *
 * WHY filter to SPAWN tools instead of any committed tool_use (as legacy's
 * broad index technically did): only spawn blocks route to provider spawn rows,
 * the sole row that consumes a notification. Matching a non-spawn tool would
 * suppress a notification that no card re-renders — silently losing the
 * result. Narrowing to spawn ids makes "suppressed here" iff "joined there",
 * which is the invariant the whole carve-out rests on. A notification whose
 * toolUseId is absent from this set is PARENTLESS (parent Task not committed,
 * or a cross-session/MCP child) and MUST keep rendering standalone.
 */
function collectSpawnToolUseIds(
  entries: readonly RawCommittedEntry[],
  provider: AgentProviderKind,
): Set<string> {
  const ids = new Set<string>()
  for (const e of entries) {
    // Spawn tool_use only ever lives in an assistant entry; skipping the rest
    // is both correct and keeps this an O(N) single pass.
    if (e.type !== 'assistant') continue
    const c = e.message?.content
    if (!Array.isArray(c)) continue
    for (const b of c) {
      const block = b as { type?: unknown; id?: unknown; name?: unknown }
      if (
        block?.type === 'tool_use' &&
        typeof block.id === 'string' &&
        typeof block.name === 'string' &&
        isAgentSpawnTool(block as ToolUseBlock, provider)
      ) {
        ids.add(block.id)
      }
    }
  }
  return ids
}

function contentKindOf(
  e: RawCommittedEntry,
  durableKind: ProviderDurableEntryKind | null,
): RenderContentKind {
  // Provider admission MUST outrank the transport's conversation discriminator:
  // both Claude and Codex persist a compact summary as a synthetic `user`
  // entry. Checking `type` first would admit the right row but relabel it as a
  // user prompt, breaking ordering/debug evidence and reopening the exact
  // compact-summary ambiguity this capability boundary removes.
  switch (durableKind) {
    case 'compact-boundary':
      return 'compact-boundary'
    case 'compact-summary':
      return 'compact-summary'
    case null:
      break
    default: {
      // Compile-time tripwire plus runtime totality: when the shared durable
      // union grows, assigning the new member to `never` fails typecheck and
      // forces this mapping to be reviewed. A stale/bypassed runtime can still
      // hand us that value before all bundles update; classify it unknown
      // instead of throwing out of the feed's total fallback path.
      const futureKind: never = durableKind
      void futureKind
      return 'unknown'
    }
  }
  if (e.type === 'assistant') return 'assistant-text'
  if (e.type === 'user') return 'user-text'
  // A non-conversation row should reach here only after provider admission,
  // but collectors are a trust boundary and the feed promises total fallback.
  // `unknown` keeps the candidate visible/debuggable if a provider violates
  // that contract rather than turning classification drift into a crash.
  return 'unknown'
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

  // P2b join-suppression evidence: which committed spawn tool_use ids exist.
  // Built ONCE up front so the per-entry notification check is a Set lookup
  // rather than an O(N²) rescan, and so a notification that appears BEFORE
  // its spawn entry in iteration order still suppresses correctly (the whole
  // committed slice is scanned before any decision is emitted).
  const spawnToolUseIds = collectSpawnToolUseIds(entries, provider)

  entries.forEach((e, index) => {
    // Ingest-time stable id (plan migration hazard: keys must never fall
    // back to visible index — index reuse after order shifts made React
    // retain wrong subtrees, the "phantom duplicate" class). uuid when the
    // provider gave one; otherwise position-at-INGEST.
    //
    // STABILITY CONTRACT (updated for the #375 live window): the entries
    // array is no longer strictly append-only — the live ingest path trims
    // the oldest entries once the window exceeds its count or byte budget
    // (MAX_LIVE_ENTRIES / MAX_LIVE_ENTRY_BYTES), and
    // older-history pagination PREPENDS (which also shifts indices; that
    // predates the window). The `ingest-${index}` fallback survives both
    // because the trimmer refuses to run at all while ANY entry in the
    // array lacks a uuid (planLiveEntryTrim constraint 1 in
    // session-runtime/liveEntryWindow.ts — the guard that keeps this id
    // scheme honest), and in practice every mapped entry carries a uuid
    // (Claude lines have them, Codex/opencode mappers synthesize them), so
    // the fallback only ever fires on arrays that are frozen against
    // trimming. If you ever make this fallback load-bearing for real
    // entries, the window guard is the other half of the contract.
    const id = `entry:${e.uuid ?? `ingest-${index}`}`

    const isConversation = CONVERSATION_TYPES.has(e.type ?? '')
    const durableKind = providerDurableEntryKind(e as Entry, provider)

    if (!isConversation && durableKind === null) {
      decisions.push({ candidateId: id, selected: false, reason: 'not-conversation', evidence: [`type=${e.type ?? 'unknown'}`] })
      return
    }
    if (isConversation && e.isMeta === true) {
      decisions.push({ candidateId: id, selected: false, reason: 'meta-entry', evidence: [] })
      return
    }
    const taskNotification = providerTaskNotificationFromEntry(
      e as Entry,
      provider,
    )
    if (taskNotification !== null) {
      const toolUseId = taskNotification.toolUseId
      // P2b join-suppression (mirrors legacy's
      // committedToolUseIndex.has(notification.toolUseId) guard): when the
      // spawn that produced this notification is committed, the provider row
      // already renders the notification INSIDE the parent Task card, so
      // selecting the standalone entry too would double-paint the same
      // background result. A PARENTLESS notification (no toolUseId, or a
      // toolUseId with no committed spawn block) has no card to join and must
      // still render standalone — hence the set-membership gate, not a blanket
      // drop of every notification. Recorded as a rejection decision (not a
      // silent skip) so a bundle can answer "why did this notification row
      // vanish": it was joined, #344's structural rule.
      if (toolUseId && spawnToolUseIds.has(toolUseId)) {
        decisions.push({
          candidateId: id,
          selected: false,
          reason: 'task-notification-joined',
          evidence: [
            `joined into committed spawn tool_use ${toolUseId} — renders inside its Task card, standalone row suppressed to avoid the P2b double-render`,
          ],
        })
        return
      }
      const text = textOf(e)
      candidates.push({
        id,
        owner: 'committed',
        provider,
        sourcePlane: 'committed',
        sessionId,
        messageId: e.message?.id,
        turnId: e.message?.id,
        toolUseId: toolUseId ?? undefined,
        contentKind: 'user-text',
        timestampMs: entryTimestampMs(e),
        sequence: index,
        normalizedTextKey: text ? normalizeTextKey(text) : undefined,
      })
      decisions.push({
        candidateId: id,
        selected: true,
        reason: 'selected',
        evidence: [
          'task-notification carve-out: background-result carrier, exempt from synthetic filter',
          toolUseId ? `tool-use-id ${toolUseId}` : 'no tool-use-id tag',
        ],
      })
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
    // Sidechain (subagent) turn (issue #477): reject BEFORE mining tools —
    // its inner Read/Bash belong to the child, not the parent, and mining
    // them as committed-owned would wrongly suppress parent live tools. The
    // same activity renders inside the Task card, so nothing is lost.
    if (e.isSidechain === true) {
      decisions.push({
        candidateId: id,
        selected: false,
        reason: 'sidechain-filtered',
        evidence: ['subagent child turn — renders inside the Task card, not the main feed'],
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
      contentKind: contentKindOf(e, durableKind),
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
