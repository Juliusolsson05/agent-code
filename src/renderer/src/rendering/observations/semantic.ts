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
  finalized?: boolean
  toolName?: string
  toolUseId?: string
  callId?: string
  itemId?: string
}

export type SemanticTurnLike = {
  turnId: string
  source?: string
  startedAtMs: number | null
  endedAtMs: number | null
  isCompactionSynthesis?: boolean
  blocks: readonly SemanticBlockLike[]
}

export type SemanticCollection = {
  candidates: RenderCandidate[]
  decisions: OwnershipDecision[]
}

const TOOL_USE_KINDS = new Set([
  'tool_use', 'server_tool_use', 'mcp_tool_use', 'function_call', 'custom_tool_call',
])
const TOOL_RESULT_KINDS = new Set([
  'tool_result', 'function_call_output', 'custom_tool_call_output', 'tool_search_output',
])
const THINKING_KINDS = new Set(['thinking', 'reasoning'])

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

    if (kind === 'thinking' && !(b.text && b.text.trim().length > 0)) {
      out.decisions.push({ candidateId: id, selected: false, reason: 'empty-thinking', evidence: [] })
      return
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
      contentKind: kind,
      timestampMs,
      // Sequence preserves intra-turn block order under equal timestamps.
      sequence: i,
      textKey: finalizedText,
      normalizedTextKey: finalizedText ? normalizeTextKey(finalizedText) : undefined,
    })
    out.decisions.push({ candidateId: id, selected: true, reason: 'selected', evidence: [] })
  })
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
