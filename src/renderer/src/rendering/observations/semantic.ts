import type { AgentProviderKind } from '@shared/types/providerKind'
import { normalizeTextKey } from '@renderer/rendering/observations/committed'
import type {
  OwnershipDecision,
  RenderCandidate,
} from '@renderer/rendering/model/types'

// ---------------------------------------------------------------------------
// Semantic candidate collector — live turns (current + history bridge) into
// BLOCK-level candidates (plan D2). Like the committed collector, the input
// is structural-narrow: this module owns exactly the fields it reads, and
// the shadow slice verifies the translation against real runtime state.
//
// Model-level guards that used to live scattered in React (renderUnits /
// StreamingTurn null-returns) become decisions here, so debug can never
// claim a semantic row exists that would paint nothing (first-principles:
// "debug must not lie about ownership"):
//   - compaction synthesis never yields candidates (#345: raw <analysis>/
//     <summary> XML rendered as assistant prose when the proxy detector's
//     request signature drifted — the model now refuses it regardless of
//     how the flag was detected)
//   - empty thinking blocks are not renderable units
//   - empty write_stdin is Codex poll noise, not content
//   - a history turn with the current turn's id is dropped (dump invariant
//     14 — history/current must never double-own one turn)
// ---------------------------------------------------------------------------

export type SemanticBlockLike = {
  blockIndex: number
  kind: string
  text?: string
  /** Thinking/reasoning payload — NOT in `text`. foldEvent mints thinking
   *  blocks with `text: ''` and stashes the actual content here: Claude in
   *  `thinking`, Codex reasoning in `reasoningSummary`/`reasoningText` (both
   *  can be empty when ChatGPT streams encrypted reasoning). These already
   *  flow through the adapter unchanged (non-tool blocks pass by reference,
   *  the tool-block `{...b}` spread preserves them) — they were just untyped,
   *  so the collector could not read them and a thinking-only turn vanished.
   *  Source of truth for the field names: workspace/workspaceState.ts
   *  SemanticLiveBlock. */
  thinking?: string
  reasoningSummary?: string
  reasoningText?: string
  finalized?: boolean
  toolName?: string
  toolUseId?: string
  callId?: string
  itemId?: string
  /** Tool blocks: result payload already paired into the block by the
   *  semantic reducer (tool_result arrival). Presence of either field is
   *  the block-local "this run resolved" evidence. */
  resultContent?: string
  resultAt?: number
  resultIsError?: boolean
  /** Turn-lookup status for this tool id (adapter stamps it from
   *  turn.lookups.toolCallsById). 'completed' is resolution evidence even
   *  when no result was paired into the block — the 2026-07-07 soak
   *  bundle showed completed Agent tools with empty block results. */
  lookupStatus?: string
}

export type SemanticTurnLike = {
  turnId: string
  source?: string
  startedAtMs: number | null
  endedAtMs: number | null
  isCompactionSynthesis?: boolean
  blocks: readonly SemanticBlockLike[]
  /** Turn-level accumulated text. Some producers (opencode headless
   *  today) deliver text ONLY here, with an empty block map — a
   *  block-level collector that ignores it makes the whole turn
   *  invisible (bundle-corpus catch: 2026-07-06 opencode bundles). */
  text?: string
}

export type SemanticCollection = {
  candidates: RenderCandidate[]
  decisions: OwnershipDecision[]
}

const TOOL_USE_KINDS = new Set([
  'tool_use', 'server_tool_use', 'mcp_tool_use', 'function_call', 'custom_tool_call',
  // Codex live block kinds (CodexResponsesAdapter.mapItemTypeToBlockKind).
  // These reach the live plane with their raw ResponseItem type as `kind`;
  // without them here blockContentKind fell through to 'assistant-text', so
  // (1) they were NOT classified as tools and committed tool ownership could
  // never suppress the live twin against its committed row, and (2)
  // isKnownBlockKind was false, spamming the UnknownBehavior registry with
  // vocabulary we already understand. Classifying them 'tool-use' is safe
  // against over-hiding: the only unconditional suppression is an EXACT
  // committed-id match (ownership.ts), and the collapsed-running hide is
  // gated on COLLAPSIBLE_CHURN_TOOLS (Claude Read/Bash/Glob/Grep only), so a
  // live Codex tool with no committed twin still paints.
  'web_search_call', 'image_generation_call', 'local_shell_call', 'tool_search_call',
])
const TOOL_RESULT_KINDS = new Set([
  'tool_result', 'function_call_output', 'custom_tool_call_output', 'tool_search_output',
])
const THINKING_KINDS = new Set(['thinking', 'reasoning'])
const TEXT_KINDS = new Set(['text', 'message', 'output_text'])

/** True when a semantic block kind maps to a KNOWN content kind. Unknown
 *  kinds still render (assistant-text fallback below — hiding content on
 *  an unrecognized label is the worse failure), but the adapter records
 *  them as UnknownBehavior sightings so new provider vocabulary surfaces
 *  in the ledger/debug output instead of silently passing as text. */
export function isKnownBlockKind(kind: string): boolean {
  return (
    TOOL_USE_KINDS.has(kind) ||
    TOOL_RESULT_KINDS.has(kind) ||
    THINKING_KINDS.has(kind) ||
    TEXT_KINDS.has(kind)
  )
}

function blockContentKind(b: SemanticBlockLike): RenderCandidate['contentKind'] {
  if (TOOL_USE_KINDS.has(b.kind)) return 'tool-use'
  if (TOOL_RESULT_KINDS.has(b.kind)) return 'tool-result'
  if (THINKING_KINDS.has(b.kind)) return 'thinking'
  return 'assistant-text'
}

function collectTurn(
  turn: SemanticTurnLike,
  owner: 'semantic-current' | 'semantic-history',
  provider: AgentProviderKind,
  sessionId: string,
  out: SemanticCollection,
): void {
  // WHY the timestamp choice (plan D4 + feed-render-item-plan): history
  // orders by when the turn ENDED (its content is complete; the ordering
  // law compares endedAt against prompt timestamps), current orders by when
  // it STARTED (it is still growing; started-after-the-prompt is what puts
  // it below the prompt).
  const timestampMs =
    owner === 'semantic-history'
      ? turn.endedAtMs ?? turn.startedAtMs
      : turn.startedAtMs

  if (turn.isCompactionSynthesis === true) {
    for (const b of turn.blocks) {
      out.decisions.push({
        candidateId: `sem:${turn.turnId}:${b.blockIndex}`,
        selected: false,
        reason: 'compaction-synthesis',
        evidence: ['turn flagged isCompactionSynthesis — raw synthesis never renders (#345)'],
      })
    }
    return
  }

  turn.blocks.forEach((b, i) => {
    const id = `sem:${turn.turnId}:${b.blockIndex}`
    const kind = blockContentKind(b)

    // Thinking content does NOT live in b.text — foldEvent sets text:'' for
    // thinking blocks and carries the payload in provider-specific fields
    // (Claude → thinking; Codex reasoning → reasoningSummary/reasoningText,
    // both often empty when ChatGPT streams encrypted reasoning). The old
    // guard checked only b.text, so a thinking-only turn produced ZERO
    // candidates and disappeared from the feed. Keep the block when ANY
    // content field has non-empty trimmed text; reject as empty-thinking only
    // when all four are hollow (e.g. encrypted, genuinely unrenderable).
    // Mirrors the ghost builder's content probe (workspace/ghosts.ts:
    // thinking || reasoningSummary || reasoningText) so live and ghost agree
    // on what counts as a paintable reasoning block.
    if (kind === 'thinking') {
      const hasThinkingContent =
        (b.thinking !== undefined && b.thinking.trim().length > 0) ||
        (b.reasoningSummary !== undefined && b.reasoningSummary.trim().length > 0) ||
        (b.reasoningText !== undefined && b.reasoningText.trim().length > 0) ||
        (b.text !== undefined && b.text.trim().length > 0)
      if (!hasThinkingContent) {
        out.decisions.push({ candidateId: id, selected: false, reason: 'empty-thinking', evidence: [] })
        return
      }
    }
    // Codex uses empty write_stdin as poll/continuation noise (dump
    // invariant 12/13): empty renders nothing, non-empty renders.
    if (b.toolName === 'write_stdin' && !(b.text && b.text.length > 0)) {
      out.decisions.push({ candidateId: id, selected: false, reason: 'empty-write-stdin', evidence: [] })
      return
    }

    // Text ownership keys ONLY on finalized text (dump: suppression applies
    // to "finalized/completed semantic text only"). A still-streaming block
    // that currently equals committed text may legitimately keep growing —
    // suppressing it mid-stream blanked live output in production.
    const finalizedText =
      kind === 'assistant-text' && b.finalized === true && b.text ? b.text : undefined

    out.candidates.push({
      id,
      owner,
      provider,
      sourcePlane: 'semantic',
      source: turn.source,
      sessionId,
      turnId: turn.turnId,
      blockIndex: b.blockIndex,
      itemId: b.itemId,
      toolUseId: b.toolUseId,
      callId: b.callId,
      toolName: b.toolName,
      contentKind: kind,
      timestampMs,
      // Sequence preserves intra-turn block order under equal timestamps.
      sequence: i,
      textKey: finalizedText,
      normalizedTextKey: finalizedText ? normalizeTextKey(finalizedText) : undefined,
      // Block-local result evidence for the ledger's collapsed-running
      // rule: a HISTORY tool block with neither this nor any committed
      // trace is a permanently-dangling run legacy deliberately withheld.
      resolved:
        kind === 'tool-use'
          ? Boolean(b.resultContent) ||
            typeof b.resultAt === 'number' ||
            b.resultIsError === true ||
            b.lookupStatus === 'completed'
          : undefined,
    })
    out.decisions.push({ candidateId: id, selected: true, reason: 'selected', evidence: [] })
  })

  // Blockless-text fallback (bundle-corpus catch, 2026-07-06 opencode
  // bundles): a turn whose producer never minted blocks but accumulated
  // turn-level text must still paint — the legacy renderer showed these
  // via SemanticStreamingTurn's turn.text path, and losing them at
  // cutover would blank real assistant output. Only fires when the block
  // loop produced NOTHING for this turn, so ids cannot collide with a
  // real block. Text key rules mirror block text: only a FINISHED turn's
  // text becomes an ownership key.
  //
  // DELIBERATELY narrow: fires only when the turn has NO blocks at all,
  // not when blocks existed and were all rejected — a rejected block
  // (empty thinking, poll noise) is a decision the ledger already
  // explains, and resurrecting the turn via text would relitigate it.
  // The observed production shape is blocks === {} with text set.
  if (turn.blocks.length === 0 && typeof turn.text === 'string' && turn.text.trim().length > 0) {
    const id = `sem:${turn.turnId}:text`
    const finished = turn.endedAtMs != null
    out.candidates.push({
      id,
      owner,
      provider,
      sourcePlane: 'semantic',
      source: turn.source,
      sessionId,
      turnId: turn.turnId,
      contentKind: 'assistant-text',
      timestampMs,
      sequence: 0,
      textKey: finished ? turn.text : undefined,
      normalizedTextKey: finished ? normalizeTextKey(turn.text) : undefined,
    })
    out.decisions.push({
      candidateId: id,
      selected: true,
      reason: 'selected',
      evidence: ['blockless turn-level text fallback'],
    })
  }
}

export function collectSemanticCandidates(
  current: SemanticTurnLike | null,
  history: readonly SemanticTurnLike[],
  provider: AgentProviderKind,
  sessionId: string,
): SemanticCollection {
  const out: SemanticCollection = { candidates: [], decisions: [] }

  for (const turn of history) {
    // Dump invariant 14: semantic history must drop the current turn's id —
    // otherwise history and current double-own one turn and the feed paints
    // it twice. Rejection recorded per block so the ledger explains it.
    if (current && turn.turnId === current.turnId) {
      for (const b of turn.blocks) {
        out.decisions.push({
          candidateId: `sem:${turn.turnId}:${b.blockIndex}`,
          selected: false,
          reason: 'duplicate-turn-in-history',
          evidence: [`turn ${turn.turnId} is the live current turn`],
        })
      }
      continue
    }
    collectTurn(turn, 'semantic-history', provider, sessionId, out)
  }
  if (current) collectTurn(current, 'semantic-current', provider, sessionId, out)

  return out
}
