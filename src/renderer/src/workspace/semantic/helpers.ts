import {
  parseSemanticTodos,
  type SemanticLiveTurn,
  type SemanticRuntimeState,
  type SemanticTodoItem,
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

/** Project a completed live turn into the short semantic history
 *  buffer.
 *
 *  WHY keep the full block map instead of the old tiny summary row:
 *  the feed has two asynchronous owners for a just-finished turn.
 *  The semantic stream knows immediately that a Codex/MCP tool round
 *  completed, while durable JSONL can lag by one or more Responses
 *  turns. If we archive only `{ turnId, text }`, the renderer has
 *  nothing to paint during that gap and the visible conversation
 *  appears to clear after each MCP call. Keeping the bounded full
 *  turn lets Feed bridge that gap and drop the semantic copy as soon
 *  as a committed entry with the same turn id arrives.
 *
 *  The cap remains small (`SEMANTIC_HISTORY_CAP`), and the clone here
 *  makes the archive immutable enough for React memo/debug use
 *  without deep-copying large parsed tool payloads. If this ever
 *  becomes memory-sensitive, the right fix is a purpose-built
 *  render-history shape, not returning to text-only summaries. */
export function semanticHistoryRow(
  turn: SemanticLiveTurn,
): SemanticLiveTurn {
  return {
    ...turn,
    blocks: { ...turn.blocks },
    blockOrder: [...turn.blockOrder],
    task: {
      ...turn.task,
      todos: [...turn.task.todos],
      inProgressToolUseIds: [...turn.task.inProgressToolUseIds],
      activeToolNames: [...turn.task.activeToolNames],
    },
    lookups: {
      ...turn.lookups,
      toolCallsById: { ...turn.lookups.toolCallsById },
      toolUseIdsInOrder: [...turn.lookups.toolUseIdsInOrder],
      resolvedToolUseIds: [...turn.lookups.resolvedToolUseIds],
      erroredToolUseIds: [...turn.lookups.erroredToolUseIds],
    },
    usage: turn.usage ? { ...turn.usage } : null,
  }
}

/** True when the turn is still live — hasn't received its
 *  terminal `turn_stopped`/`turn_completed` yet. Used by session-
 *  status derivation and the foldSemanticEvent branch that decides
 *  whether to archive a turn or keep it open across a pending
 *  tool_result. */
export function isSemanticTurnRunning(
  turn: SemanticLiveTurn | null,
): turn is SemanticLiveTurn {
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

/** True when the turn still has at least one tool-call block that's
 *  waiting on its result. The foldSemanticEvent `turn_completed`
 *  branch keeps the turn alive whenever this is true so a late
 *  result doesn't land in a closed turn.
 *
 *  Covers both Claude's kinds (tool_use / server_tool_use /
 *  mcp_tool_use — pending indicator is `resultAt == null` on a
 *  block that has a toolUseId) AND Codex's kinds (function_call /
 *  custom_tool_call — pending indicator is `resultAt == null` on a
 *  block that has a callId). The Codex branch is load-bearing:
 *  without it, a Codex turn that commits one tool round before the
 *  next one starts trivially returns false here, and the turn-lifecycle
 *  logic upstream treats the turn as completable — closing it while
 *  the agent is actively issuing more function_call items in the
 *  same turn. See the debug-bundle finding (2026-04-23) where
 *  `currentTurn.endedAt` stayed null for 2 minutes; had turn_completed
 *  ever fired on that session, this check would have returned false
 *  and closed the turn prematurely.
 */
export function hasPendingSemanticTools(turn: SemanticLiveTurn): boolean {
  return Object.values(turn.blocks).some(block => {
    if (
      block.kind === 'tool_use' ||
      block.kind === 'server_tool_use' ||
      block.kind === 'mcp_tool_use'
    ) {
      return block.toolUseId != null && block.resultAt == null
    }
    if (
      block.kind === 'function_call' ||
      block.kind === 'custom_tool_call'
    ) {
      return block.callId != null && block.resultAt == null
    }
    return false
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
 * semantic lookup snapshot is the same idea for Agent Code's live turn:
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
  let todos: SemanticTodoItem[] = emptySemanticTaskSnapshot().todos

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
