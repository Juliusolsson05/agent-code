import type { Entry } from '@shared/types/transcript'
import { isCompactSummaryEntry } from '@providers/claude/types/claudeTranscript'
import type {
  ClaudeCompactionState,
  ClaudeConditionSnapshot,
  ProviderConditionSnapshot,
} from '@shared/types/providerConditions'
import { conditionStateByKind } from '@shared/types/providerConditions'
import type { SemanticLiveTurn } from '@renderer/session-runtime/state'

export type ClaudeCompactionConditionInput = {
  snapshot: ProviderConditionSnapshot | null
  currentTurn: SemanticLiveTurn | null
  entries: readonly Entry[]
}

function screenCompaction(snapshot: ProviderConditionSnapshot | null): ClaudeCompactionState | null {
  if (snapshot?.provider !== 'claude') return null
  const state = conditionStateByKind<ClaudeCompactionState>(snapshot, 'claude.compaction')
  return state ? { ...state, source: 'screen' } : null
}

/**
 * Merge Claude's structured synthesis lifecycle with the terminal parser.
 *
 * The proxy flag is the strongest start signal and the durable summary is the
 * strongest completion signal. Screen parsing is retained only for older or
 * proxy-less sessions and for the one fact not exposed structurally today: a
 * compaction error. This keeps the fallback useful without letting a stale
 * screen frame regress a structured operation back to "running".
 */
export function normalizeClaudeCompactionConditions({
  snapshot,
  currentTurn,
  entries,
}: ClaudeCompactionConditionInput): ProviderConditionSnapshot | null {
  const screen = screenCompaction(snapshot)
  const summaryTimes = entries
    .filter(isCompactSummaryEntry)
    .map(entry => Date.parse(entry.timestamp ?? ''))
    // A missing timestamp cannot prove operation correlation. Treating NaN as
    // "recent" made any old summary without time instantly complete a new
    // compaction synthesis — the opposite of an evidence-first decision.
    .filter(Number.isFinite)
  const latestSummaryAt = summaryTimes.length > 0 ? Math.max(...summaryTimes) : null
  if (currentTurn?.isCompactionSynthesis !== true) {
    if (!screen || snapshot?.provider !== 'claude') return snapshot
    // Once a durable summary exists, a screen-only `running` frame cannot
    // prove a newer operation. Let the next structured synthesis turn reopen
    // the lifecycle instead. This monotonic rule deliberately favors durable
    // replay evidence over a terminal parser that may keep emitting stale
    // frames; older no-proxy sessions still get screen fallback before their
    // first durable summary.
    const summaryClosedScreenOperation = latestSummaryAt !== null
    return {
      ...snapshot,
      conditions: {
        ...snapshot.conditions,
        'claude.compaction': {
          ...snapshot.conditions['claude.compaction']!,
          state: summaryClosedScreenOperation
            ? {
                visible: true,
                phase: 'done',
                statusText: 'Conversation compacted',
                source: 'structured',
              }
            : screen,
        },
      },
    }
  }

  const summaryArrived = latestSummaryAt !== null &&
    latestSummaryAt >= currentTurn.startedAt - 5_000
  const state: ClaudeCompactionState = summaryArrived
    ? {
          visible: true,
          phase: 'done',
          statusText: 'Conversation compacted',
          source: 'structured',
          operationId: currentTurn.turnId,
        }
    : screen?.phase === 'error'
      ? {
          ...screen,
          visible: true,
          source: 'screen',
          operationId: currentTurn.turnId,
        }
      : {
          visible: true,
          phase: 'running',
          statusText: currentTurn.endedAt === null
            ? 'Compacting conversation…'
            : 'Finalizing compacted conversation…',
          source: 'structured',
          operationId: currentTurn.turnId,
        }

  let base: ClaudeConditionSnapshot
  if (snapshot?.provider === 'claude') {
    // ProviderConditionSnapshot is intentionally erased for IPC, so checking
    // its provider string cannot recover the mapped condition type. Rebuild
    // the precise Claude shell at this single provider boundary; individual
    // state access above still goes through the typed kind selector.
    base = {
      provider: 'claude',
      conditions: snapshot.conditions as ClaudeConditionSnapshot['conditions'],
      ts: snapshot.ts,
    }
  } else base = { provider: 'claude', conditions: {}, ts: currentTurn.startedAt }
  return {
    ...base,
    conditions: {
      ...base.conditions,
      'claude.compaction': {
        kind: 'claude.compaction',
        state,
        actions: [],
      },
    },
  }
}
