import type { AgentProviderKind } from '@shared/types/providerKind'
import type {
  OwnershipDecision,
  RenderCandidate,
} from '@renderer/rendering/model/types'

// ---------------------------------------------------------------------------
// Committed-ownership suppression (plan D3, D10) — the heart of the ledger.
//
// Pipeline position: AFTER committed visibility, BEFORE ordering. Decides,
// for every live candidate (semantic-current / semantic-history /
// optimistic-submit), whether a committed candidate already owns the same
// visible artifact. Rejected candidates KEEP their decision record — that
// is the whole point (plan §0; #344's structural fix).
//
// The suppress-vs-reorder discriminator (plan D3): committed OWNS the unit
// → suppress with reason; committed has NOT caught up → the unit stays and
// gets ORDERED chronologically. Suppressing un-owned history is data loss:
// per #159/#290 the committed channel can be permanently dead, and the
// history bridge may be the only representation of a turn that ever exists.
// ---------------------------------------------------------------------------

/**
 * Ownership evidence sets built from the committed candidates of one pass.
 * Mirrors the legacy `buildCommittedAssistantText` triple-key design (dump):
 * Claude correlates by message id; Codex proxy ids (resp_*) never match
 * rollout ids so exact/normalized TEXT is the fallback ownership proof; and
 * both are conservative on purpose — never prefix, never fuzzy (plan §7
 * rule 5). Fuzzy matching would hide legitimate live text that repeats a
 * sentence.
 */
export type CommittedOwnership = {
  wholeTurnOwnerIds: ReadonlySet<string>
  exactText: ReadonlySet<string>
  normalizedText: ReadonlySet<string>
  toolUseIds: ReadonlySet<string>
  toolResultIds: ReadonlySet<string>
  itemIds: ReadonlySet<string>
  /** Normalized committed USER text — optimistic reconciliation only. */
  userTextKeys: ReadonlySet<string>
}

/**
 * Per-provider suppression policy (plan D10: asymmetry is policy, not
 * forks). `wholeTurnByMessageId` is ONLY safe when the provider's durable
 * row provably carries the semantic turn id (Claude: message.id == turnId).
 * Codex commits one response item at a time and SHARES broad turn ids
 * across items, so whole-turn suppression hides still-live output — the
 * exact #165/#191 regression class. OpenCode follows Codex (unit-level):
 * its concurrency lands via committed assembly, and note the drift report:
 * opencode committed rows DO carry message ids, which is why this is an
 * explicit policy bit and not an id-presence heuristic — presence of an id
 * does not make whole-turn suppression semantically safe.
 */
export type SuppressionPolicy = {
  wholeTurnByMessageId: boolean
  /**
   * Collapsed-running null-paint (legacy semanticRenderUnitPaintsDom
   * behavior; corpus new-bug 2026-06-29 1b2b5e96): hide a HISTORY tool
   * block whose run never resolved — no result paired into the block AND
   * no committed tool_use/tool_result trace. CLAUDE ONLY: its tool
   * results always pair into the block (semantic reducer) or land as
   * committed rows, so absence of both means the run truly died. Codex is
   * excluded because its MCP lifecycle delivers function_call_output in a
   * LATER semantic turn — block-local evidence is legitimately absent and
   * committed reconstruction may lag; the corpus proved the rule
   * over-fires there (15 fixtures went missing-in-next). Opencode's
   * committed channel is assembled server truth; no dangling-chip bundle
   * exists for it — revisit if one appears.
   */
  hideUnresolvedHistoryTools: boolean
}

export const SUPPRESSION_POLICY: Record<AgentProviderKind, SuppressionPolicy> = {
  claude: { wholeTurnByMessageId: true, hideUnresolvedHistoryTools: true },
  codex: { wholeTurnByMessageId: false, hideUnresolvedHistoryTools: false },
  opencode: { wholeTurnByMessageId: false, hideUnresolvedHistoryTools: false },
}

/** The legacy collapsed_activity churn set (helpers.ts
 *  classifySemanticToolActivity): the only tools whose RUNNING history
 *  blocks null-paint. Source of truth is that classifier until Stage 3
 *  absorbs it; keep in sync. */
const COLLAPSIBLE_CHURN_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'FileRead',
  'Glob',
  'Grep',
  'Bash',
])

export function buildCommittedOwnership(
  committed: readonly RenderCandidate[],
): CommittedOwnership {
  const wholeTurnOwnerIds = new Set<string>()
  const exactText = new Set<string>()
  const normalizedText = new Set<string>()
  const toolUseIds = new Set<string>()
  const toolResultIds = new Set<string>()
  const itemIds = new Set<string>()
  const userTextKeys = new Set<string>()
  for (const c of committed) {
    // Block-grain evidence mined at collection time (see RenderCandidate
    // .ownedToolUseIds WHY). This is the corpus-proven path for claude:
    // tool blocks live INSIDE entry-grain rows, so the contentKind
    // branches below never fire for them.
    for (const id of c.ownedToolUseIds ?? []) toolUseIds.add(id)
    for (const id of c.ownedToolResultIds ?? []) toolResultIds.add(id)
    if (c.contentKind === 'user-text' && c.normalizedTextKey) {
      userTextKeys.add(c.normalizedTextKey)
    }
    if (c.contentKind === 'assistant-text') {
      if (c.messageId) wholeTurnOwnerIds.add(c.messageId)
      if (c.textKey) exactText.add(c.textKey)
      if (c.normalizedTextKey) normalizedText.add(c.normalizedTextKey)
    }
    if (c.contentKind === 'tool-use') {
      if (c.toolUseId) toolUseIds.add(c.toolUseId)
      if (c.callId) toolUseIds.add(c.callId)
      if (c.itemId) itemIds.add(c.itemId)
    }
    if (c.contentKind === 'tool-result') {
      if (c.toolUseId) toolResultIds.add(c.toolUseId)
      if (c.callId) toolResultIds.add(c.callId)
    }
  }
  return { wholeTurnOwnerIds, exactText, normalizedText, toolUseIds, toolResultIds, itemIds, userTextKeys }
}

/**
 * Decide one live candidate against committed ownership. Returns a full
 * decision either way — selected candidates get 'selected', rejected ones
 * get their reason + who won (plan D5's ownership_decision schema).
 */
export function decideLiveCandidate(
  candidate: RenderCandidate,
  ownership: CommittedOwnership,
  policy: SuppressionPolicy,
  /** Newest committed entry timestamp (producer clock, null on fresh
   *  sessions) — the collapsed-running rule's tail gate reads it. */
  committedTailMs: number | null = null,
): OwnershipDecision {
  const evidence: string[] = []

  // Optimistic prompt reconciliation (plan D1 handoff): the committed user
  // row owns its optimistic stand-in by normalized text. Bias is toward the
  // optimistic row SURVIVING when no owner is provable — surviving too long
  // is visible and diagnosable; vanishing early is the silent #339 class.
  if (candidate.owner === 'optimistic-submit') {
    if (
      candidate.normalizedTextKey &&
      ownership.userTextKeys.has(candidate.normalizedTextKey)
    ) {
      evidence.push('committed user row with matching normalized text')
      return {
        candidateId: candidate.id,
        selected: false,
        reason: 'optimistic-owned-by-committed',
        evidence,
      }
    }
    return { candidateId: candidate.id, selected: true, reason: 'selected', evidence }
  }

  // Whole-turn suppression: policy-gated, only for history bridges (a LIVE
  // current turn matching a committed id means committed caught up while
  // still streaming — units below handle it; killing the whole live turn
  // here would blank legitimately-new blocks).
  if (
    policy.wholeTurnByMessageId &&
    candidate.owner === 'semantic-history' &&
    candidate.turnId &&
    ownership.wholeTurnOwnerIds.has(candidate.turnId)
  ) {
    evidence.push(`committed message.id == turnId ${candidate.turnId}`)
    return {
      candidateId: candidate.id,
      selected: false,
      reason: 'claude-whole-turn-suppressed',
      suppressionOwnerId: candidate.turnId,
      evidence,
    }
  }

  if (candidate.contentKind === 'assistant-text') {
    if (candidate.textKey && ownership.exactText.has(candidate.textKey)) {
      evidence.push('exact committed text match')
      return { candidateId: candidate.id, selected: false, reason: 'committed-text-owned', evidence }
    }
    if (
      candidate.normalizedTextKey &&
      ownership.normalizedText.has(candidate.normalizedTextKey)
    ) {
      evidence.push('normalized committed text match')
      return { candidateId: candidate.id, selected: false, reason: 'committed-text-owned', evidence }
    }
  }

  if (candidate.contentKind === 'tool-use') {
    const key = candidate.toolUseId ?? candidate.callId
    if (key && ownership.toolUseIds.has(key)) {
      evidence.push(`committed tool_use ${key}`)
      return { candidateId: candidate.id, selected: false, reason: 'committed-tool-use-owned', evidence }
    }
    if (candidate.itemId && ownership.itemIds.has(candidate.itemId)) {
      evidence.push(`committed response item ${candidate.itemId}`)
      return { candidateId: candidate.id, selected: false, reason: 'committed-tool-use-owned', evidence }
    }
    // Collapsed-running null-paint (corpus new-bug, 2026-06-29 1b2b5e96;
    // legacy semanticRenderUnitPaintsDom behavior): a HISTORY tool block
    // whose run never resolved anywhere — no result paired into the block
    // AND no committed tool_use or tool_result trace — is a permanently-
    // dangling chip ("Read · running" forever). Legacy deliberately
    // withheld it; we do too, with the decision on the record. Scoped to
    // history ONLY: the current turn's unresolved tools are legitimately
    // awaiting results (that is what streaming looks like), and codex's
    // MCP next-turn-output lifecycle resolves via a LATER turn — when the
    // result eventually lands (block pairing or committed row), the
    // candidate re-decides and paints, so this is never a permanent hide
    // of a live run.
    if (
      policy.hideUnresolvedHistoryTools &&
      candidate.owner === 'semantic-history' &&
      candidate.resolved !== true &&
      // TAIL GATE (2026-07-07 soak bundle 5b19529f — the first live catch,
      // and a rule this pipeline's own law already stated: "not caught up
      // means REORDER, never suppress"). An unresolved churn tool is only
      // provably DEAD when committed truth has moved PAST its turn —
      // committed entries newer than the turn's end exist, yet none of
      // them recorded this tool. During normal streaming the committed
      // tail lags BEHIND recent history turns (19s in the soak bundle),
      // and in-flight Read/Bash fan-outs were vanishing mid-run under the
      // v1 rule. Same trick as ghost rule 4, same pure inputs, no wall
      // clock — the ledger's identity cache stays sound.
      committedTailMs !== null &&
      candidate.timestampMs !== null &&
      committedTailMs > candidate.timestampMs &&
      // Legacy parity is EXACTLY the collapsed_activity churn set
      // (classifySemanticToolActivity): Read/Glob/Grep/Bash fold into a
      // collapsed run that null-paints while running. Everything else —
      // Task, Edit, AskUserQuestion, MCP tools — paints even while
      // unresolved (a running Task chip is live subagent signal, not
      // churn). The first, broader version of this rule hid those and the
      // corpus caught it within one run: 6 claude fixtures went
      // missing-in-next on legitimate running chips.
      candidate.toolName !== undefined &&
      COLLAPSIBLE_CHURN_TOOLS.has(candidate.toolName)
    ) {
      const key = candidate.toolUseId ?? candidate.callId
      const committedTrace =
        (key !== undefined && (ownership.toolUseIds.has(key) || ownership.toolResultIds.has(key))) ||
        (candidate.itemId !== undefined && ownership.itemIds.has(candidate.itemId))
      if (!committedTrace) {
        evidence.push('churn tool, no block result, no committed tool_use/tool_result trace')
        return { candidateId: candidate.id, selected: false, reason: 'collapsed-running', evidence }
      }
    }
  }

  // Tool OUTPUT yields only to a committed tool RESULT — never to the
  // tool-use commit alone. A command card can commit before its stdout;
  // hiding live output at tool-use commit time made output vanish before
  // the durable copy existed (dump invariant 10, prior shipped regression).
  if (candidate.contentKind === 'tool-result') {
    const key = candidate.toolUseId ?? candidate.callId
    if (key && ownership.toolResultIds.has(key)) {
      evidence.push(`committed tool_result ${key}`)
      return { candidateId: candidate.id, selected: false, reason: 'committed-tool-result-owned', evidence }
    }
  }

  return { candidateId: candidate.id, selected: true, reason: 'selected', evidence }
}
