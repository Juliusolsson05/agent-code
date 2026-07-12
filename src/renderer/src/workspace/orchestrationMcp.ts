import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type { AgentProviderKind } from '@shared/types/providerKind'
import type {
  OrchestrationAgentMessage,
  OrchestrationAgentOutput,
  OrchestrationAgentRecord,
  OrchestrationCloseResult,
  OrchestrationLifecycleState,
} from '@mcp/shared/orchestrationTypes'
import { entryTextContent } from '@renderer/session-runtime/entries'
import { isSessionExited } from '@renderer/workspace/providerSessionIdentity'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { SessionId, SessionMeta, WorkspaceState } from '@renderer/workspace/types'

type RuntimeMap = Record<SessionId, SessionRuntime>
type VisibleMessageSummary = {
  messages: OrchestrationAgentMessage[]
  messageCount: number
  latestAssistantText?: string
  // True when text was cut or older messages were dropped by count/char caps.
  truncated: boolean
  // Sum of ORIGINAL char counts of the texts we actually extracted for this
  // response (returned tail + latest-assistant lookup). Not the whole
  // transcript — see the WHY inside visibleMessageSummary.
  totalChars: number
}

const DEFAULT_MAX_MESSAGES = 20
// Byte caps (#373). Count caps alone did not bound orchestration reads: a
// single child message can be hundreds of KB (pasted diffs, giant tool output
// surfacing as assistant text), and one answer used to be mirrored 5x per
// read (see buildAgentRecord). Defaults are copied from the transcript MCP
// tools (AgentTranscriptReader DEFAULT_MAX_CHARS / DEFAULT_MAX_CHARS_PER_ITEM)
// so "bounded agent output" means the same thing across both consumption
// surfaces.
const DEFAULT_MAX_CHARS_PER_MESSAGE = 4_000
const DEFAULT_MAX_CHARS_PER_AGENT = 24_000
// Size of the at-a-glance excerpt kept on agent-record mirror fields
// (latestAssistantText/finalAssistantText on OrchestrationAgentRecord and
// output.finalAssistantText). Big enough to recognize an answer and decide
// whether to read more; small enough that repeating it per agent in
// list/wait responses stays cheap.
const MIRROR_EXCERPT_MAX_CHARS = 400

export function listOrchestrationAgents(params: {
  state: WorkspaceState
  runtimes: RuntimeMap
  parentSessionId: string
  runId?: string
}): OrchestrationAgentRecord[] {
  return matchingOrchestrationSessionIds(params.state, params.parentSessionId, params.runId)
    .map(sessionId => {
      const meta = params.state.sessions[sessionId]
      if (!meta) return null
      return buildAgentRecord({
        sessionId,
        meta,
        parentSessionId: params.parentSessionId,
        runtime: params.runtimes[sessionId] ?? null,
        mode: 'status',
      })
    })
    .filter((agent): agent is OrchestrationAgentRecord => agent !== null)
}

export function readOrchestrationAgent(params: {
  state: WorkspaceState
  runtimes: RuntimeMap
  parentSessionId: string
  sessionId: string
  maxMessages?: number
  maxCharsPerMessage?: number
  maxCharsPerAgent?: number
}): OrchestrationAgentOutput {
  const meta = params.state.sessions[params.sessionId]
  if (!meta || !isVisibleToOrchestrationParent(meta, params.parentSessionId)) {
    throw new Error('Orchestration agent not found for this parent session.')
  }
  const runtime = params.runtimes[params.sessionId] ?? null
  return buildAgentOutput({
    sessionId: params.sessionId,
    meta,
    parentSessionId: params.parentSessionId,
    runtime,
    maxMessages: params.maxMessages,
    maxCharsPerMessage: params.maxCharsPerMessage,
    maxCharsPerAgent: params.maxCharsPerAgent,
  })
}

export function readOrchestrationRunOutputs(params: {
  state: WorkspaceState
  runtimes: RuntimeMap
  parentSessionId: string
  runId?: string
  maxMessagesPerAgent?: number
  maxCharsPerMessage?: number
  maxCharsPerAgent?: number
}): OrchestrationAgentOutput[] {
  return matchingOrchestrationSessionIds(params.state, params.parentSessionId, params.runId)
    .map(sessionId => {
      const meta = params.state.sessions[sessionId]
      if (!meta) return null
      return buildAgentOutput({
        sessionId,
        meta,
        parentSessionId: params.parentSessionId,
        runtime: params.runtimes[sessionId] ?? null,
        maxMessages: params.maxMessagesPerAgent,
        maxCharsPerMessage: params.maxCharsPerMessage,
        maxCharsPerAgent: params.maxCharsPerAgent,
      })
    })
    .filter((output): output is OrchestrationAgentOutput => output !== null)
}

export async function closeOrchestrationAgent(params: {
  state: WorkspaceState
  parentSessionId: string
  sessionId: string
  closeSession: (sessionId: SessionId) => Promise<void>
}): Promise<OrchestrationCloseResult> {
  const meta = params.state.sessions[params.sessionId]
  if (!meta || !isVisibleToOrchestrationParent(meta, params.parentSessionId)) {
    throw new Error('Orchestration agent not found for this parent session.')
  }
  await params.closeSession(params.sessionId)
  return { closedSessionIds: [params.sessionId] }
}

export async function closeOrchestrationRun(params: {
  state: WorkspaceState
  parentSessionId: string
  runId?: string
  closeSession: (sessionId: SessionId) => Promise<void>
}): Promise<OrchestrationCloseResult> {
  const sessionIds = matchingOrchestrationSessionIds(
    params.state,
    params.parentSessionId,
    params.runId,
  )
  const closedSessionIds: string[] = []
  const skippedSessionIds: string[] = []
  for (const sessionId of sessionIds) {
    try {
      await params.closeSession(sessionId)
      closedSessionIds.push(sessionId)
    } catch {
      skippedSessionIds.push(sessionId)
    }
  }
  return {
    closedSessionIds,
    ...(skippedSessionIds.length > 0 ? { skippedSessionIds } : {}),
  }
}

export function markOrchestrationBootstrapPromptDelivered(params: {
  state: WorkspaceState
  parentSessionId: string
  sessionId: string
}): WorkspaceState {
  const meta = params.state.sessions[params.sessionId]
  if (!meta || !isVisibleToOrchestrationParent(meta, params.parentSessionId)) {
    return params.state
  }
  return {
    ...params.state,
    sessions: {
      ...params.state.sessions,
      [params.sessionId]: {
        ...meta,
        orchestrationBootstrapPromptDelivered: true,
      },
    },
  }
}

function matchingOrchestrationSessionIds(
  state: WorkspaceState,
  parentSessionId: string,
  runId?: string,
): SessionId[] {
  return Object.entries(state.sessions)
    .filter(([, meta]) => {
      const kind = meta.kind ?? DEFAULT_PROVIDER
      // Registry-driven: any registered agent provider (Claude, Codex,
      // OpenCode, …) is a valid orchestration child. The old two-provider
      // literal here would silently exclude OpenCode children — MCP tools
      // like `list_agents` and `close_run` would then miss them, and
      // `matchingOrchestrationSessionIds` would return the wrong scope.
      if (!isAgentProviderKind(kind)) return false
      if (!isVisibleToOrchestrationParent(meta, parentSessionId)) return false
      return runId ? meta.orchestrationRunId === runId : true
    })
    .map(([sessionId]) => sessionId)
}

function isVisibleToOrchestrationParent(meta: SessionMeta, parentSessionId: string): boolean {
  // WHY every orchestration read/close goes through this ownership gate:
  // the MCP tool caller is itself an agent session. Letting that session
  // close or inspect arbitrary panes would turn orchestration into a global
  // workspace-control API. The intended contract is narrower: a parent can
  // coordinate the children it created, plus descendants in the same root run,
  // and nothing else. This is especially important for `close-run`, where a
  // missing runId should mean "all of MY children", not "all agents on screen".
  return (
    meta.orchestrationParentId === parentSessionId ||
    meta.orchestrationRootId === parentSessionId
  )
}

function buildAgentOutput(params: {
  sessionId: SessionId
  meta: SessionMeta
  parentSessionId: string
  runtime: SessionRuntime | null
  maxMessages?: number
  maxCharsPerMessage?: number
  maxCharsPerAgent?: number
}): OrchestrationAgentOutput {
  const summary = visibleMessageSummary(
    params.runtime,
    params.meta,
    boundedMaxMessages(params.maxMessages),
    boundedMaxCharsPerMessage(params.maxCharsPerMessage),
    boundedMaxCharsPerAgent(params.maxCharsPerAgent),
  )
  const { messages, messageCount, latestAssistantText, truncated, totalChars } = summary
  const agent = buildAgentRecord({
    sessionId: params.sessionId,
    meta: params.meta,
    parentSessionId: params.parentSessionId,
    runtime: params.runtime,
    messages,
    messageCount,
    latestAssistantText,
  })
  // WHY the output no longer re-spreads latest/finalAssistantText into `agent`
  // (#373): before this change ONE child answer appeared verbatim FIVE times
  // in a single read_agent response — messages[last].text,
  // agent.latestAssistantText, agent.finalAssistantText,
  // output.latestAssistantText, output.finalAssistantText (and seven times for
  // closed agents in wait_agents, which also returns the agents[] records).
  // finalAssistantText was never independently computed; it was always a
  // verbatim alias of latestAssistantText assigned right here. We keep exactly
  // one full (per-message-capped) copy at output.latestAssistantText; every
  // other mirror is a short excerpt produced by buildAgentRecord /
  // mirrorExcerpt so existing readers keep working without the 5x payload.
  return {
    agent: {
      ...agent,
      messageCount,
    },
    messages,
    ...(latestAssistantText
      ? {
          latestAssistantText,
          finalAssistantText: mirrorExcerpt(latestAssistantText),
        }
      : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(totalChars > 0 ? { totalChars } : {}),
  }
}

function buildAgentRecord(params: {
  sessionId: SessionId
  meta: SessionMeta
  parentSessionId: string
  runtime: SessionRuntime | null
  messages?: OrchestrationAgentMessage[]
  messageCount?: number
  latestAssistantText?: string
  mode?: 'status' | 'output'
}): OrchestrationAgentRecord {
  const statusOnly = params.mode === 'status' && params.messages === undefined
  // WHY list/status avoids visibleMessages(): orchestration_wait_agents polls
  // this path while children are actively writing huge tool/worktree outputs.
  // Materializing every user/assistant text block for every child turns a cheap
  // status poll into O(children * transcript text) renderer work and can starve
  // the bridge that must answer the poll. Full message extraction remains on
  // read-agent/read-run-outputs; list only needs enough information to classify
  // lifecycle and activity.
  const messages = statusOnly ? [] : (params.messages ?? visibleMessages(params.runtime, params.meta))
  const latestAssistantText = statusOnly
    ? undefined
    : (params.latestAssistantText ?? latestAssistant(messages))
  const hasDurableOutput = statusOnly
    ? hasAssistantOutput(params.runtime, params.meta)
    : Boolean(latestAssistantText)
  const lifecycleState = lifecycleStateForRuntime(params.runtime, hasDurableOutput)
  const activityAt = lastActivityAt(params.runtime, messages)
  return {
    sessionId: params.sessionId,
    kind: (params.meta.kind ?? DEFAULT_PROVIDER) as AgentProviderKind,
    cwd: params.meta.cwd,
    ...(params.meta.title ? { title: params.meta.title } : {}),
    orchestrationParentId: params.meta.orchestrationParentId ?? params.parentSessionId,
    orchestrationRootId: params.meta.orchestrationRootId ?? params.parentSessionId,
    ...(params.meta.orchestrationRunId ? { orchestrationRunId: params.meta.orchestrationRunId } : {}),
    ...(params.meta.orchestrationRole ? { orchestrationRole: params.meta.orchestrationRole } : {}),
    ...(params.meta.inheritedParentContext
      ? {
          inheritedParentContext: true,
          ...(params.meta.inheritedParentProviderSessionId
            ? { inheritedParentProviderSessionId: params.meta.inheritedParentProviderSessionId }
            : {}),
          ...(params.meta.inheritedProviderSessionId
            ? { inheritedProviderSessionId: params.meta.inheritedProviderSessionId }
            : {}),
        }
      : {}),
    ...(params.meta.orchestrationBootstrapPromptDelivered
      ? { orchestrationBootstrapPromptDelivered: true }
      : {}),
    lifecycleState,
    statusSummary: statusSummary(params.runtime, lifecycleState),
    ...(activityAt ? { lastActivityAt: activityAt } : {}),
    ...(lifecycleState === 'completed' && activityAt
      ? { completedAt: activityAt }
      : {}),
    ...(params.runtime?.processError ? { errorSummary: params.runtime.processError } : {}),
    // Bounded excerpts on purpose (#373): the record-level mirrors exist as
    // at-a-glance hints in list/wait/agents[] payloads, so a full answer here
    // multiplied every child answer across responses (the 5x/7x duplication —
    // see buildAgentOutput). The full capped copy lives ONLY at
    // output.latestAssistantText.
    //
    // LIFECYCLE HAZARD: hasDurableOutput above is derived from
    // latestAssistantText. Excerpting must never turn non-empty text into
    // empty/absent, or completed children regress to `waiting` and
    // wait_agents never resolves. mirrorExcerpt only shortens, never drops.
    ...(latestAssistantText
      ? {
          latestAssistantText: mirrorExcerpt(latestAssistantText),
          finalAssistantText: mirrorExcerpt(latestAssistantText),
        }
      : {}),
    messageCount: params.messageCount
      ?? (statusOnly ? cheapMessageCount(params.runtime, params.meta) : messages.length),
  }
}

function lifecycleStateForRuntime(
  runtime: SessionRuntime | null,
  hasDurableOutput = false,
): OrchestrationLifecycleState {
  // STAGE 1 of 2: renderer-derived lifecycle. Main overlays prompt-delivery
  // timing to report `prompt_sent`; see OrchestrationBridge.lifecycleWithPromptDelivery.
  // WHY this derives from renderer runtime instead of provider internals:
  // orchestration's contract is "what can the parent safely coordinate on?"
  // The feed/runtime state is the same user-visible truth Dispatch and panes
  // render. A provider process can be alive while a prompt is still pending,
  // or idle after a final response; the runtime already folds those signals
  // into fields that survive Claude/Codex implementation differences.
  if (!runtime) return 'created'
  if (runtime.processStatus === 'failed' || runtime.processError) return 'failed'
  if (isSessionExited(runtime)) return 'closed'
  if (
    runtime.sessionStatus === 'running' ||
    runtime.processActive ||
    runtime.awaitingAssistant ||
    runtime.streamPhase !== 'idle'
  ) {
    return 'running'
  }
  if (hasDurableOutput) return 'completed'
  if (runtime.inputReady || runtime.processStatus === 'started') return 'waiting'
  return 'created'
}

function statusSummary(
  runtime: SessionRuntime | null,
  lifecycleState: OrchestrationLifecycleState,
): string {
  if (!runtime) return 'created'
  if (runtime.processError) return runtime.processError
  if (runtime.streamPhase && runtime.streamPhase !== 'idle') return runtime.streamPhase
  if (runtime.sessionStatus === 'running') return 'running'
  return lifecycleState
}

function visibleMessages(
  runtime: SessionRuntime | null,
  meta?: SessionMeta,
): OrchestrationAgentMessage[] {
  if (!runtime) return []
  const messages: OrchestrationAgentMessage[] = []
  const entries = orchestrationVisibleEntries(runtime, meta)
  for (const entry of entries) {
    if (entry.type !== 'user' && entry.type !== 'assistant') continue
    const text = entryTextContent(entry)
    if (!text?.trim()) continue
    messages.push({
      role: entry.type,
      // Defensive per-message cap (#373): this fallback path has no caller
      // that threads explicit caps today (buildAgentOutput always supplies
      // messages), but if a future caller reaches it, an uncapped message
      // must not resurrect the unbounded-read problem.
      ...boundedMessageFields(text, DEFAULT_MAX_CHARS_PER_MESSAGE),
      ...((entry as { timestamp?: string }).timestamp ? { timestamp: (entry as { timestamp?: string }).timestamp } : {}),
    })
  }
  const liveText = runtime.semantic.currentTurn?.text?.trim()
  if (liveText) {
    messages.push({
      role: 'assistant',
      ...boundedMessageFields(liveText, DEFAULT_MAX_CHARS_PER_MESSAGE),
    })
  }
  return messages
}

function visibleMessageSummary(
  runtime: SessionRuntime | null,
  meta: SessionMeta | undefined,
  maxMessages: number,
  maxCharsPerMessage: number,
  maxCharsPerAgent: number,
): VisibleMessageSummary {
  if (!runtime) {
    return {
      messages: [],
      messageCount: 0,
      truncated: false,
      totalChars: 0,
    }
  }
  // WHY this scans from the tail and only extracts text for messages that can
  // affect the bounded response: orchestration_send_prompt preflights children
  // with maxMessages=1, and wait/read-run-output may ask every child for a
  // small tail. The previous implementation materialized every visible message
  // and sliced afterward, so a tiny read still paid for huge tool transcripts
  // on the renderer thread. We keep messageCount as a cheap visible-entry count
  // rather than exact non-empty text count because exactness would require the
  // same full text extraction this path exists to avoid.
  //
  // BYTE CAPS (#373): counts alone never bounded this response — one pasted
  // diff in a child message is enough to blow the parent's context. Every
  // extracted text is capped at maxCharsPerMessage, and the returned tail as a
  // whole shares a maxCharsPerAgent running budget. Because the scan walks
  // newest -> oldest, "budget exhausted" naturally drops the OLDEST messages
  // first, mirroring the transcript reader's boundItems budget semantics.
  // The NEWEST message is exempt from dropping: it is truncated down to the
  // agent budget instead (see the floor inside pushTail), so a starved budget
  // still returns a non-empty tail.
  // totalChars only sums the ORIGINAL sizes of texts we actually extracted:
  // whole-transcript totals would require the full extraction this fast path
  // exists to avoid.
  const messagesReversed: OrchestrationAgentMessage[] = []
  let messageCount = 0
  let latestAssistantText: string | undefined
  let usedChars = 0
  let totalChars = 0
  let truncated = false
  let budgetExhausted = false

  const pushTail = (
    role: 'user' | 'assistant',
    rawText: string,
    timestamp?: string,
  ): { text: string; truncated: boolean } | null => {
    let bounded = boundText(rawText, maxCharsPerMessage)
    if (usedChars + bounded.text.length > maxCharsPerAgent) {
      if (messagesReversed.length > 0) {
        // Everything older than this point is dropped too (the scan only gets
        // older from here), so flip the latch instead of retrying per message.
        budgetExhausted = true
        truncated = true
        return null
      }
      // NEWEST-MESSAGE FLOOR (#510 review): the first push is the newest
      // message in the tail (live turn if present, else the newest visible
      // entry). Dropping it because maxCharsPerAgent is smaller than one
      // per-message-capped text would return `messages: []` for an agent that
      // plainly produced output — budget starvation must degrade to a shorter
      // excerpt, never to nothing. usedChars is always 0 here (nothing kept
      // yet), so the whole agent budget is available; boundedMaxCharsPerAgent
      // clamps it to >=100, which keeps a 76-char excerpt + marker even in the
      // worst case. Older messages then fail the budget check above and drop
      // as before.
      bounded = boundText(rawText, maxCharsPerAgent)
      truncated = true
    }
    usedChars += bounded.text.length
    totalChars += bounded.totalChars
    if (bounded.truncated) truncated = true
    messagesReversed.push({
      role,
      text: bounded.text,
      ...(timestamp ? { timestamp } : {}),
      ...(bounded.truncated ? { truncated: true, totalChars: bounded.totalChars } : {}),
    })
    return bounded
  }

  const liveText = runtime.semantic.currentTurn?.text?.trim()
  if (liveText) {
    messageCount += 1
    const pushed = pushTail('assistant', liveText)
    // The live turn is the newest assistant text whether or not it fit the
    // tail budget. Cap it like any message; NEVER drop it (lifecycle hazard —
    // see buildAgentRecord).
    latestAssistantText = pushed?.text ?? boundText(liveText, maxCharsPerMessage).text
    if (!pushed) totalChars += liveText.length
  }

  const entries = orchestrationVisibleEntries(runtime, meta)
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!
    if (entry.type !== 'user' && entry.type !== 'assistant') continue
    messageCount += 1

    const needsTailMessage = !budgetExhausted && messagesReversed.length < maxMessages
    const needsLatestAssistant = entry.type === 'assistant' && !latestAssistantText
    if (!needsTailMessage && !needsLatestAssistant) {
      // There is at least one visible entry beyond what the caps allow, so the
      // caller must know the tail is an excerpt of a longer conversation.
      // (Slight over-report is possible when the skipped entry has empty text;
      // acceptable, because checking would need the extraction we skip.)
      truncated = true
      continue
    }

    const text = entryTextContent(entry)
    if (!text?.trim()) continue
    const timestamp = (entry as { timestamp?: string }).timestamp
    let pushed: { text: string } | null = null
    if (needsTailMessage) {
      pushed = pushTail(entry.type, text, timestamp)
    }
    if (needsLatestAssistant) {
      const boundedLatest = pushed ?? boundText(text, maxCharsPerMessage)
      latestAssistantText = boundedLatest.text
      if (!pushed) {
        totalChars += text.length
        if (text.length > maxCharsPerMessage) truncated = true
      }
    }
  }

  return {
    messages: messagesReversed.reverse(),
    messageCount,
    ...(latestAssistantText ? { latestAssistantText } : {}),
    truncated,
    totalChars,
  }
}

// Truncation marker deliberately matches AgentTranscriptReader.truncateItemText
// (same "…\n[truncated]" shape, same 24-char headroom) so parent agents see one
// consistent truncation dialect across transcript tools and orchestration reads.
function boundText(text: string, maxChars: number): {
  text: string
  truncated: boolean
  totalChars: number
} {
  if (text.length <= maxChars) {
    return { text, truncated: false, totalChars: text.length }
  }
  return {
    text: `${text.slice(0, Math.max(0, maxChars - 24))}\n[truncated]`,
    truncated: true,
    totalChars: text.length,
  }
}

function boundedMessageFields(
  text: string,
  maxChars: number,
): Pick<OrchestrationAgentMessage, 'text' | 'truncated' | 'totalChars'> {
  const bounded = boundText(text, maxChars)
  return {
    text: bounded.text,
    ...(bounded.truncated ? { truncated: true, totalChars: bounded.totalChars } : {}),
  }
}

function mirrorExcerpt(text: string): string {
  return boundText(text, MIRROR_EXCERPT_MAX_CHARS).text
}

function hasAssistantOutput(
  runtime: SessionRuntime | null,
  meta?: SessionMeta,
): boolean {
  if (!runtime) return false
  if (runtime.semantic.currentTurn?.text?.trim()) return true
  return orchestrationVisibleEntries(runtime, meta).some(entry => (
    entry.type === 'assistant'
  ))
}

function cheapMessageCount(
  runtime: SessionRuntime | null,
  meta?: SessionMeta,
): number {
  if (!runtime) return 0
  let count = 0
  for (const entry of orchestrationVisibleEntries(runtime, meta)) {
    if (entry.type === 'assistant' || entry.type === 'user') count += 1
  }
  if (runtime.semantic.currentTurn?.text?.trim()) count += 1
  return count
}

function orchestrationVisibleEntries(
  runtime: SessionRuntime,
  meta?: SessionMeta,
): SessionRuntime['entries'] {
  // DORMANT: current agent creation explicitly disables inherited parent
  // transcript context, so fresh agents never set inheritedParentContext=true.
  // Keep the cut below for pre-disable persisted sessions and the active
  // inheritance redesign, but do not treat it as part of the normal read path.
  // WHY inherited children need a transcript cut point:
  // context inheritance deliberately resumes a duplicated parent transcript so
  // the child can read the conversation that led to its task. That history is
  // useful model context, but it is not the child's work product. The MCP
  // read/list tools are consumed by the parent coordinator, so reporting the
  // last assistant message from the whole resumed transcript can make a child
  // appear to have returned the parent's old commentary instead of its own
  // answer. The bootstrap prompt is the durable, provider-agnostic marker we
  // write after spawning the child; everything before the child's bootstrap is
  // inherited context, everything from it onward is the child session.
  //
  // Use the LAST handoff marker, not the first. A parent can itself be an
  // orchestrated child, so its duplicated transcript may already contain an
  // older handoff. Cutting at the first marker would resurrect the same bug for
  // grandchildren by treating the parent's child-task output as the current
  // child's output. The newest handoff is the one submitted by this launch.
  //
  // We only apply this cut after the bootstrap has been marked delivered. That
  // preserves old behavior for regular agents, failed pre-prompt launches, and
  // any older inherited sessions whose transcript does not contain the marker.
  if (
    meta?.inheritedParentContext !== true ||
    meta.orchestrationBootstrapPromptDelivered !== true
  ) {
    return runtime.entries
  }
  const bootstrapIndex = lastIndexWhere(runtime.entries, entry => {
    if (entry.type !== 'user') return false
    const text = entryTextContent(entry)
    // WHY this cannot assume every user entry has text:
    // provider transcripts also represent tool-result and other structured
    // user-role payloads as `type: "user"`. Orchestration reads scan
    // backwards through the duplicated transcript, so one structured user
    // entry after the bootstrap marker used to crash `.includes()` before the
    // parent could read, list, or wait on an otherwise healthy child.
    return text?.includes('<orchestration-handoff>') === true
  })
  if (bootstrapIndex < 0) return runtime.entries
  return runtime.entries.slice(bootstrapIndex)
}

function lastIndexWhere<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index]!)) return index
  }
  return -1
}

function latestAssistant(messages: OrchestrationAgentMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role === 'assistant' && message.text.trim()) return message.text
  }
  return undefined
}

function lastActivityAt(
  runtime: SessionRuntime | null,
  messages: OrchestrationAgentMessage[],
): number | undefined {
  if (!runtime) return undefined
  if (runtime.phaseChangedAt) return runtime.phaseChangedAt
  if (runtime.turnStartedAt) return runtime.turnStartedAt
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const timestamp = messages[index]?.timestamp
    const parsed = timestamp ? Date.parse(timestamp) : NaN
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function boundedMaxMessages(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_MESSAGES
  if (!Number.isFinite(value)) return DEFAULT_MAX_MESSAGES
  return Math.max(1, Math.min(100, Math.floor(value)))
}

// Clamp ranges intentionally match the transcript MCP tool schemas
// (createBuiltInMcpServer: maxCharsPerItem 50..100_000, maxChars
// 100..500_000) so a caller can reuse the same numbers on both surfaces. The
// clamp is enforced here — not just in the zod schema — because renderer
// requests also arrive from main-side callers (bridge tombstone reads) that
// never pass through the MCP schema.
function boundedMaxCharsPerMessage(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_CHARS_PER_MESSAGE
  return Math.max(50, Math.min(100_000, Math.floor(value)))
}

function boundedMaxCharsPerAgent(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_CHARS_PER_AGENT
  return Math.max(100, Math.min(500_000, Math.floor(value)))
}
