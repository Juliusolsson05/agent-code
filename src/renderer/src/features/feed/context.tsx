import type { TaskNotification } from '@renderer/session-runtime/taskNotification'
import { createContext } from 'react'

import type {
  ToolResultBlock,
} from '@shared/types/transcript'

import type { SubAgentState } from '@renderer/session-runtime/state'
import type { ClaudeAskUserQuestionState } from '@shared/types/providerConditions'

// ---------------------------------------------------------------------------
// Feed contexts.
//
// The pure presentation projection now carries provider identity and paired
// tool evidence structurally. Context remains only for genuinely session-wide
// state a leaf cannot own:
//
//   ToolResultIndexContext  — durable completion evidence used by a pruned
//                             TaskSubagentRow.
//   CodeRenderContext       — sessionId + workspaceRoot, passed to
//                             fenced code blocks inside prose so the
//                             CodeBlock can mint stable codeIds and
//                             wire LSP against the right root.
//
// The runtime maintains indexes incrementally behind stable Map references.
// Feed clones them only when `toolIndexVersion` bumps: that fresh identity
// invalidates the pure projector (so a later result enriches its OperationVM)
// and this narrow TaskSubagent context, without rebuilding indexes on unrelated
// entry renders. Ordinary operations receive paired evidence structurally and
// do not read these maps through React context.

// TaskSubagentRow consults this map after its live watcher state has been
// pruned. Other operations receive paired results directly from the projector.
export const ToolResultIndexContext =
  createContext<Map<string, ToolResultBlock>>(new Map())

export const CodeRenderContext = createContext<{
  sessionId: string
  workspaceRoot: string | null
}>({
  sessionId: '',
  workspaceRoot: null,
})

// Subagent fleet state for this session, keyed by parent `Agent` tool_use id.
// The `Agent` tool_use row (and the "Spawned N agents" group header) read this
// to render live status + the drill-in tool-call timeline. Same side-channel
// rationale as the maps above: the row only sees its own block, but needs the
// session-wide subagent map that lives one level up on the runtime. Empty `{}`
// when no subagents exist, so consumers render the plain spawn card.
export const SubAgentsContext = createContext<Record<string, SubAgentState>>({})

/** toolUseId → parsed <task-notification> (P2b). Built in Feed from
 *  committed entries beside the tool indexes; TaskSubagentRow reads it as
 *  its highest-priority status/result evidence (a notification is the
 *  task's own completion report — it outranks watcher-derived state). */
export const TaskNotificationsContext = createContext<
  ReadonlyMap<string, TaskNotification>
>(new Map())

// Live AskUserQuestion screen state for answerability only.
//
// WHY this is a separate side-channel instead of part of CodeRenderContext:
// sessionId/workspaceRoot are stable render metadata used by many code/markdown
// leaves. The AUQ state is a volatile screen-derived condition used by exactly
// one semantic row to decide whether controls should still be clickable. Keeping
// it separate prevents a terminal repaint from invalidating unrelated code-block
// consumers while still avoiding prop drilling through every feed row.
//
// Undefined means "unknown/no snapshot yet"; null means "we have a conditions
// snapshot and the picker is absent." The row uses that distinction to disable
// only when absence is positively known, which closes the stray-digit race
// without turning transient parser misses into flickery UI.
export const AskUserQuestionConditionContext =
  createContext<ClaudeAskUserQuestionState | null | undefined>(undefined)
