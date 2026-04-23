import {
  parseSemanticTodos,
  type SemanticLiveTurn,
  type SemanticRuntimeState,
  type SessionRuntime,
  type SessionStatus,
  type SessionStatusSource,
} from '@renderer/workspace/workspaceState'

// ---------------------------------------------------------------------------
// Size caps for the semantic runtime ring buffers
// ---------------------------------------------------------------------------
//
// Sessions can emit hundreds of semantic events per minute during a
// busy turn. Unbounded accumulation of log/history/error arrays
// bloats memory and makes the proxy debug panel render slower. The
// caps here are generous for interactive use — past these sizes the
// oldest entries drop off the head. See foldSemanticEvent.ts for the
// .slice(-CAP) trim applied after each push.

export const SEMANTIC_LOG_CAP = 200
export const SEMANTIC_HISTORY_CAP = 20
export const SEMANTIC_ERROR_CAP = 20

// ---------------------------------------------------------------------------
// Small pure helpers on SemanticEvent payloads
// ---------------------------------------------------------------------------

/** Narrow an unknown value to a finite number or null. Used when
 *  reading `blockIndex` off an event payload — the schema says
 *  number, but payloads are typed `unknown` at the fold boundary
 *  so we defensively check. */
export function semanticToIndex(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Truncate a semantic id for display. turn ids and tool-use ids
 *  can be 24+ chars long; the debug panel wants an at-a-glance
 *  string, not a full correlation id. */
export function trimSemanticId(v: unknown): string {
  const s = typeof v === 'string' ? v : ''
  return s.length > 14 ? s.slice(0, 14) + '…' : s
}

/** Flatten `usage` — a nested object of token counters — into a
 *  single-level Record<string, number|string> so the debug panel
 *  can render it as key/value rows without recursive traversal.
 *  Sub-object keys become dotted paths (`cache.reads`). */
export function flattenSemanticUsage(
  u: Record<string, unknown>,
): Record<string, number | string | undefined> {
  const out: Record<string, number | string | undefined> = {}
  for (const [k, v] of Object.entries(u)) {
    if (typeof v === 'number' || typeof v === 'string') out[k] = v
    else if (v && typeof v === 'object') {
      for (const [ck, cv] of Object.entries(v as Record<string, unknown>)) {
        if (typeof cv === 'number' || typeof cv === 'string') {
          out[`${k}.${ck}`] = cv
        }
      }
    }
  }
  return out
}

/** Project a completed live turn into a history row — the summary
 *  shape that survives after the turn archives. History rows lose
 *  the per-block map to keep memory bounded; consumers that need
 *  block detail for a past turn must read from the raw transcript. */
export function semanticHistoryRow(
  turn: SemanticLiveTurn,
): Pick<SemanticLiveTurn, 'turnId' | 'text' | 'stopReason' | 'startedAt' | 'endedAt'> {
  return {
    turnId: turn.turnId,
    text: turn.text,
    stopReason: turn.stopReason,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
  }
}

/** True when the turn is still live — hasn't received its
 *  terminal `turn_stopped`/`turn_completed` yet. Used by session-
 *  status derivation and the foldSemanticEvent branch that decides
 *  whether to archive a turn or keep it open across a pending
 *  tool_result. */
export function isSemanticTurnRunning(turn: SemanticLiveTurn | null): boolean {
  return turn !== null && turn.endedAt === null
}

// ---------------------------------------------------------------------------
// Session status derivation
// ---------------------------------------------------------------------------
//
// Single source of truth for "what phase is this session in".
// Composes five independent signals into one SessionStatus string:
//   - exited       (session_exit event)
//   - semantic     (turn actively streaming)
//   - process      (provider subprocess active)
//   - submit       (optimistic awaitingAssistant flag)
//   - idle         (none of the above)
// The earlier a branch fires, the higher its priority — so a dead
// session always reports 'exited' even if a stale process flag
// lingered.

export function deriveSessionStatus(runtime: SessionRuntime): {
  sessionStatus: SessionStatus
  sessionStatusSource: SessionStatusSource
} {
  if (runtime.exited !== null) {
    return { sessionStatus: 'exited', sessionStatusSource: 'exit' }
  }
  if (isSemanticTurnRunning(runtime.semantic.currentTurn)) {
    return { sessionStatus: 'running', sessionStatusSource: 'semantic' }
  }
  if (runtime.processActive) {
    return { sessionStatus: 'running', sessionStatusSource: 'process' }
  }
  if (runtime.awaitingAssistant) {
    return { sessionStatus: 'running', sessionStatusSource: 'submit' }
  }
  return { sessionStatus: 'idle', sessionStatusSource: 'none' }
}

/** Merge the derived status fields back onto a runtime patch.
 *  Every setRuntimes mutation that might affect status goes through
 *  this so the status slot stays consistent with its inputs. */
export function withDerivedSessionStatus(runtime: SessionRuntime): SessionRuntime {
  return {
    ...runtime,
    ...deriveSessionStatus(runtime),
  }
}

// ---------------------------------------------------------------------------
// Pending-tool bookkeeping
// ---------------------------------------------------------------------------

/** True when the turn still has at least one tool_use block that's
 *  waiting on its tool_result. The foldSemanticEvent `turn_completed`
 *  branch keeps the turn alive whenever this is true so a late
 *  tool_result doesn't land in a closed turn. */
export function hasPendingSemanticTools(turn: SemanticLiveTurn): boolean {
  return Object.values(turn.blocks).some(block => {
    if (
      block.kind !== 'tool_use' &&
      block.kind !== 'server_tool_use' &&
      block.kind !== 'mcp_tool_use'
    ) {
      return false
    }
    return block.toolUseId != null && block.resultAt == null
  })
}

// ---------------------------------------------------------------------------
// Empty-state factories
// ---------------------------------------------------------------------------

export function emptySemanticTaskSnapshot() {
  return {
    todos: [],
    doneCount: 0,
    totalCount: 0,
    inProgressToolUseIds: [] as string[],
    activeToolNames: [] as string[],
  }
}

export function emptySemanticLookupSnapshot(): SemanticLiveTurn['lookups'] {
  return {
    toolCallsById: {},
    toolUseIdsInOrder: [],
    resolvedToolUseIds: [],
    erroredToolUseIds: [],
  }
}

// ---------------------------------------------------------------------------
// Task snapshot derivation
// ---------------------------------------------------------------------------

/**
 * WHY derive a lookup snapshot here instead of teaching Feed to scan
 * blocks every render:
 *
 * Upstream Claude does not let render components rediscover tool state
 * from raw transcript rows. It builds a relationship layer first
 * (`toolUseByToolUseID`, `toolResultByToolUseID`, `resolvedToolUseIDs`,
 * sibling sets, progress maps) and then renders from that. This smaller
 * semantic lookup snapshot is the same idea for cc-shell's live turn:
 * keep the expensive / correctness-sensitive "which tool is still live,
 * which one errored, which tools were siblings in this turn?" logic in
 * the shared reducer so every surface reads the same answer.
 */
export function deriveSemanticTaskSnapshot(
  blocks: Record<number, SemanticLiveTurn['blocks'][number]>,
): {
  task: SemanticLiveTurn['task']
  lookups: SemanticLiveTurn['lookups']
} {
  const inProgressToolUseIds: string[] = []
  const activeToolNames: string[] = []
  const resolvedToolUseIds: string[] = []
  const erroredToolUseIds: string[] = []
  const toolUseIdsInOrder: string[] = []
  const toolCallsById: SemanticLiveTurn['lookups']['toolCallsById'] = {}
  let todos = emptySemanticTaskSnapshot().todos

  const orderedBlocks = Object.values(blocks).sort((a, b) => a.blockIndex - b.blockIndex)
  for (const block of orderedBlocks) {
    if (
      block.kind !== 'tool_use' &&
      block.kind !== 'server_tool_use' &&
      block.kind !== 'mcp_tool_use'
    ) {
      continue
    }
    const hasResult = block.resultAt != null
    if (block.toolUseId && !hasResult) {
      inProgressToolUseIds.push(block.toolUseId)
      if (block.toolName) activeToolNames.push(block.toolName)
    }
    if (block.toolUseId) {
      toolUseIdsInOrder.push(block.toolUseId)
      if (hasResult) {
        resolvedToolUseIds.push(block.toolUseId)
        if (block.resultIsError) erroredToolUseIds.push(block.toolUseId)
      }
      toolCallsById[block.toolUseId] = {
        toolUseId: block.toolUseId,
        blockIndex: block.blockIndex,
        kind: block.kind,
        toolName: block.toolName ?? null,
        status: block.resultIsError
          ? 'error'
          : hasResult
            ? 'completed'
            : 'in_progress',
        inputJson: block.inputJson ?? '',
        resultContent: block.resultContent ?? null,
      }
    }
    if (block.toolName === 'TodoWrite' && block.parsedInput) {
      todos = parseSemanticTodos(block.parsedInput)
    }
  }

  const dedupedToolNames = [...new Set(activeToolNames)]
  const doneCount = todos.filter(todo => todo.status === 'completed').length
  return {
    task: {
      todos,
      doneCount,
      totalCount: todos.length,
      inProgressToolUseIds,
      activeToolNames: dedupedToolNames,
    },
    lookups: {
      toolCallsById,
      toolUseIdsInOrder,
      resolvedToolUseIds,
      erroredToolUseIds,
    },
  }
}

// Re-export the foundational types so foldEvent.ts can import them
// through this module rather than reaching into workspaceState directly
// (keeps the semantic/* layer coherent).
export type {
  SemanticLiveTurn,
  SemanticRuntimeState,
  SessionRuntime,
  SessionStatus,
  SessionStatusSource,
}
