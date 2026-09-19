// Is this agent working right now? — the main-process answer (#964,
// docs/decomposition/agent-working-time.md Stage 4).
//
// The analytics records WORKING time, so the recorder needs the same notion of
// "working" the in-feed counter paints. The counter's state is the renderer's
// stream-phase machine (session-runtime/semantic/streamPhaseMachine.ts). This
// module applies the same rules to the events main already receives:
//
//   - `stream_phase` sets the phase; any non-idle phase is work, `idle` ends it.
//   - `tool_result` for the tool an `awaiting-tool` phase waits on moves to
//     `requesting`, the renderer's gap-filler. Both are work; it matters because a
//     later `turn_completed` may idle `requesting` but never `awaiting-tool`.
//   - `turn_started` starts work only when no `stream_phase` has ever been seen for
//     the session (OpenCode publishes turns, not phases — the renderer's turn
//     bridge exists for the same reason).
//   - `turn_completed` ends work unless the phase is `awaiting-tool` OR the turn
//     still has a tool owed a result. The second half is the renderer's
//     hasPendingSemanticTools guard on the folded turn, so this module keeps the
//     same minimal bookkeeping the fold does: a tool opens on `block_started` (a
//     tool kind) or `tool_started`, closes on `tool_result` or `tool_completed`,
//     and is forgotten when a new turn replaces the old one. Without it, main went
//     idle for one event whenever an adapter completed a turn just before
//     announcing `awaiting-tool` — found by the equivalence test, which is the
//     reason it exists.
//   - a visible condition that needs the user (permission prompt, question) pauses
//     work: time blocked on the human is not agent working time (§6 Q4).
//   - the session leaving the manager ends work.
//
// WHY not import the renderer reducer: main may not depend on renderer code, and
// that reducer consults the full semantic fold that only the renderer runs. The
// divergence risk this creates is closed by workingStateEquivalence.test.ts, which
// drives the REAL Claude and Codex adapters into both reducers and requires
// identical working state event by event.
//
// Suspensions are deliberately NOT handled here: intervals are recorded as
// observed, and the summary subtracts the stored machine suspensions with the
// same function the counter uses. A later improvement to sleep detection then
// corrects past numbers instead of being baked into them.

export type WorkingState = {
  phase: string
  /** Whether any `stream_phase` was ever observed for this session. */
  phaseDriven: boolean
  /** The tool an `awaiting-tool` phase waits on, for the tool_result gap-filler. */
  pendingToolUseId: string | null
  /** The turn `pendingTools` belong to. */
  turnId: string | null
  /** Tools of that turn still owed a result (the fold's hasPendingSemanticTools). */
  pendingTools: readonly string[]
  blocked: boolean
  ended: boolean
}

export const INITIAL_WORKING_STATE: WorkingState = {
  phase: 'idle',
  phaseDriven: false,
  pendingToolUseId: null,
  turnId: null,
  pendingTools: [],
  blocked: false,
  ended: false,
}

export type WorkingSignal =
  | { type: 'semantic'; event: unknown }
  | { type: 'attention'; blocked: boolean }
  | { type: 'ended' }

export function isWorking(state: WorkingState): boolean {
  return !state.ended && !state.blocked && state.phase !== 'idle'
}

// The same kind split hasPendingSemanticTools makes: Anthropic-style tool blocks
// are identified by toolUseId (the fold mirrors callId into it), OpenAI-style
// calls by callId only.
const TOOL_USE_KINDS = new Set(['tool_use', 'server_tool_use', 'mcp_tool_use'])
const CALL_KINDS = new Set(['function_call', 'custom_tool_call'])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function openTool(state: WorkingState, id: string | null): WorkingState {
  return id && !state.pendingTools.includes(id) ? { ...state, pendingTools: [...state.pendingTools, id] } : state
}

function closeTool(state: WorkingState, id: string | null): WorkingState {
  return id && state.pendingTools.includes(id)
    ? { ...state, pendingTools: state.pendingTools.filter(tool => tool !== id) }
    : state
}

/** Next state; returns the same object when the signal changes nothing, so a
 *  caller can detect transitions by identity plus `isWorking`. */
export function reduceWorkingState(state: WorkingState, signal: WorkingSignal): WorkingState {
  if (state.ended) return state
  if (signal.type === 'ended') return { ...state, ended: true, phase: 'idle', pendingToolUseId: null }
  if (signal.type === 'attention') {
    return signal.blocked === state.blocked ? state : { ...state, blocked: signal.blocked }
  }
  const event = asRecord(signal.event)
  const type = str(event?.type) ?? ''
  switch (type) {
    case 'stream_phase': {
      const phase = str(event?.phase) ?? 'idle'
      const toolUseId = str(event?.toolUseId)
      if (phase !== state.phase || !state.phaseDriven) {
        return { ...state, phase, phaseDriven: true, pendingToolUseId: phase === 'idle' ? null : toolUseId }
      }
      // Same phase re-emitted: only a tool id upgrade (null → real id) matters.
      if (phase !== 'idle' && toolUseId !== null && toolUseId !== state.pendingToolUseId) {
        return { ...state, pendingToolUseId: toolUseId }
      }
      return state
    }
    case 'turn_started': {
      const turnId = str(event?.turnId)
      // A different turn replaces the old one, and its unresolved tools with it.
      const next = turnId && turnId !== state.turnId ? { ...state, turnId, pendingTools: [] } : state
      if (next.phaseDriven || next.phase !== 'idle') return next
      return { ...next, phase: 'responding' }
    }
    case 'block_started': {
      const kind = str(event?.kind) ?? ''
      const callId = str(event?.callId)
      if (TOOL_USE_KINDS.has(kind)) return openTool(state, str(event?.toolUseId) ?? callId)
      if (CALL_KINDS.has(kind)) return openTool(state, callId)
      return state
    }
    case 'tool_started':
      return openTool(state, str(event?.callId))
    case 'tool_completed':
      return closeTool(state, str(event?.callId))
    case 'tool_result': {
      const toolUseId = str(event?.toolUseId)
      const next = closeTool(state, toolUseId)
      if (next.phase !== 'awaiting-tool' || toolUseId === null || toolUseId !== next.pendingToolUseId) return next
      return { ...next, phase: 'requesting', pendingToolUseId: null }
    }
    case 'turn_completed': {
      if (state.phase === 'idle' || state.phase === 'awaiting-tool' || state.pendingTools.length > 0) return state
      return { ...state, phase: 'idle', pendingToolUseId: null }
    }
    default:
      return state
  }
}
