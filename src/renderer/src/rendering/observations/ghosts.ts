import type { AgentProviderKind } from '@shared/types/providerKind'
import type { GhostLedgerCandidate } from '@renderer/rendering/model/ledger'

// ---------------------------------------------------------------------------
// Ghost collector: runtime ghost map → ledger ghost plane.
//
// The runtime's ghost reducer (workspace/ghosts.ts) already does the
// LIFECYCLE work — mint, reconcile-supersede, orphan, gc. This collector
// does NONE of that; it only translates each ghost record's current state
// into (paintable candidate + predicate facts) pairs so the five-rule gate
// in model/ghostPredicate.ts can decide. Keeping lifecycle and decision
// separate is the point of the rewrite: the legacy selectMergedEntries
// fused both into one filter loop, which is why its rejections were
// invisible in debug output.
//
// Like every collector here, the input is a STRUCTURAL type (`GhostLike`),
// not atp's GhostEntry import. WHY: the pipeline stays runtime-agnostic so
// fixtures can be hand-written JSON (the whole Stage-1 test strategy), and
// the shadow adapter is the single place that vouches a real GhostEntry
// satisfies the shape.
// ---------------------------------------------------------------------------

export type GhostLike = {
  uuid?: string
  message?: {
    role?: string
    content?: unknown
  }
  _atp: {
    turnId: string
    blockIndex?: number
    supersededBy?: string
    orphanedAt?: number
    updatedAt: number
  }
}

type ContentBlockLike = { type?: string; text?: unknown; id?: string }

/**
 * Predicate-fact extraction mirroring legacy `ghostHasSidecarShape`
 * (mergedEntries.ts): assistant role + exactly one text block → the
 * sidecar fingerprint candidate; the LENGTH is what rule 5 thresholds.
 * Null means "not sidecar-shaped at all" (multi-block, tool_use, user) —
 * rule 5 never fires on null.
 */
function assistantSingleTextLength(ghost: GhostLike): number | null {
  if (ghost.message?.role !== 'assistant') return null
  const content = ghost.message?.content
  if (!Array.isArray(content) || content.length !== 1) return null
  const block = content[0] as ContentBlockLike
  if (block?.type !== 'text' || typeof block.text !== 'string') return null
  return block.text.length
}

function hasToolUseBlock(ghost: GhostLike): boolean {
  const content = ghost.message?.content
  if (!Array.isArray(content)) return false
  return content.some(b => (b as ContentBlockLike)?.type === 'tool_use')
}

export function collectGhostCandidates(
  ghosts: ReadonlyMap<string, GhostLike>,
  provider: AgentProviderKind,
  sessionId: string,
): GhostLedgerCandidate[] {
  // Opencode gate (plan §ghosts): opencode's mapper mints ghosts with no
  // supersede key — reconcileUpstream can never match them, so every one
  // eventually orphans and, being real turn content, passes the shape
  // backstop too. Rendering them would double every opencode turn. Until
  // opencode grows a supersede identity, its ghost plane is bookkeeping
  // only (crash-recovery journal), never a render source. Gating HERE
  // (collector, with the provider in hand) and not in the predicate keeps
  // the five rules provider-neutral.
  if (provider === 'opencode') return []

  const out: GhostLedgerCandidate[] = []
  for (const [uuid, ghost] of ghosts) {
    const toolUse = hasToolUseBlock(ghost)
    const singleTextLen = assistantSingleTextLength(ghost)
    out.push({
      candidate: {
        id: `ghost:${ghost.uuid ?? uuid}`,
        owner: 'ghost-fallback',
        provider,
        sourcePlane: 'ghost',
        sessionId,
        turnId: ghost._atp.turnId,
        blockIndex: ghost._atp.blockIndex,
        contentKind: toolUse ? 'tool-use' : 'assistant-text',
        // Ghost updatedAt is a LOCAL clock (renderer minted it), which the
        // D4 trust hierarchy ranks below committed producer timestamps —
        // but a rendered ghost only ever paints when committed has stalled
        // BEHIND it (rule 4), so in practice it always lands at the tail.
        timestampMs: ghost._atp.updatedAt,
        sequence: ghost._atp.blockIndex ?? 0,
      },
      predicate: {
        id: `ghost:${ghost.uuid ?? uuid}`,
        turnId: ghost._atp.turnId,
        superseded: ghost._atp.supersededBy !== undefined,
        orphaned: ghost._atp.orphanedAt !== undefined,
        updatedAtMs: ghost._atp.updatedAt,
        assistantSingleTextLength: singleTextLen,
        toolUse,
      },
    })
  }
  return out
}
