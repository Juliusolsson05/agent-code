import type {
  OrchestrationAgentMessage,
  OrchestrationAgentOutput,
  OrchestrationAgentRecord,
  OrchestrationCloseResult,
  OrchestrationLifecycleState,
} from '@mcp/shared/orchestrationTypes'
import { entryTextContent } from '@renderer/workspace/entries/utils'
import type { SessionRuntime } from '@renderer/workspace/workspaceState'
import type { SessionId, SessionMeta, WorkspaceState } from '@renderer/workspace/types'

type RuntimeMap = Record<SessionId, SessionRuntime>

const DEFAULT_MAX_MESSAGES = 20

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
  })
}

export function readOrchestrationRunOutputs(params: {
  state: WorkspaceState
  runtimes: RuntimeMap
  parentSessionId: string
  runId?: string
  maxMessagesPerAgent?: number
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
      const kind = meta.kind ?? 'claude'
      if (kind !== 'claude' && kind !== 'codex') return false
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
}): OrchestrationAgentOutput {
  const messages = visibleMessages(params.runtime, params.meta)
  const cappedMessages = messages.slice(-boundedMaxMessages(params.maxMessages))
  const latestAssistantText = latestAssistant(messages)
  const agent = buildAgentRecord({
    sessionId: params.sessionId,
    meta: params.meta,
    parentSessionId: params.parentSessionId,
    runtime: params.runtime,
    messages,
  })
  return {
    agent: {
      ...agent,
      ...(latestAssistantText ? { latestAssistantText, finalAssistantText: latestAssistantText } : {}),
      messageCount: messages.length,
    },
    messages: cappedMessages,
    ...(latestAssistantText ? { latestAssistantText, finalAssistantText: latestAssistantText } : {}),
  }
}

function buildAgentRecord(params: {
  sessionId: SessionId
  meta: SessionMeta
  parentSessionId: string
  runtime: SessionRuntime | null
  messages?: OrchestrationAgentMessage[]
}): OrchestrationAgentRecord {
  const messages = params.messages ?? visibleMessages(params.runtime, params.meta)
  const latestAssistantText = latestAssistant(messages)
  const lifecycleState = lifecycleStateForRuntime(params.runtime, latestAssistantText)
  const activityAt = lastActivityAt(params.runtime, messages)
  return {
    sessionId: params.sessionId,
    kind: (params.meta.kind ?? 'claude') as 'claude' | 'codex',
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
    ...(latestAssistantText ? { latestAssistantText, finalAssistantText: latestAssistantText } : {}),
    messageCount: messages.length,
  }
}

function lifecycleStateForRuntime(
  runtime: SessionRuntime | null,
  latestAssistantText?: string,
): OrchestrationLifecycleState {
  // WHY this derives from renderer runtime instead of provider internals:
  // orchestration's contract is "what can the parent safely coordinate on?"
  // The feed/runtime state is the same user-visible truth Dispatch and panes
  // render. A provider process can be alive while a prompt is still pending,
  // or idle after a final response; the runtime already folds those signals
  // into fields that survive Claude/Codex implementation differences.
  if (!runtime) return 'created'
  if (runtime.processStatus === 'failed' || runtime.processError) return 'failed'
  if (runtime.exited !== null || runtime.processStatus === 'exited') return 'closed'
  if (
    runtime.sessionStatus === 'running' ||
    runtime.processActive ||
    runtime.awaitingAssistant ||
    runtime.streamPhase !== 'idle'
  ) {
    return 'running'
  }
  if (latestAssistantText) return 'completed'
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
      text,
      ...((entry as { timestamp?: string }).timestamp ? { timestamp: (entry as { timestamp?: string }).timestamp } : {}),
    })
  }
  const liveText = runtime.semantic.currentTurn?.text?.trim()
  if (liveText) {
    messages.push({
      role: 'assistant',
      text: liveText,
    })
  }
  return messages
}

function orchestrationVisibleEntries(
  runtime: SessionRuntime,
  meta?: SessionMeta,
): SessionRuntime['entries'] {
  // WHY inherited children need a transcript cut point:
  // context inheritance deliberately resumes a duplicated parent transcript so
  // the child can read the conversation that led to its task. That history is
  // useful model context, but it is not the child's work product. The MCP
  // read/list tools are consumed by the parent coordinator, so reporting the
  // last assistant message from the whole resumed transcript can make a child
  // appear to have returned the parent's old commentary instead of its own
  // answer. The bootstrap prompt is the first durable, provider-agnostic marker
  // we write after spawning the child; everything before it is inherited
  // context, everything from it onward is the child session.
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
  const bootstrapIndex = runtime.entries.findIndex(entry => {
    if (entry.type !== 'user') return false
    return entryTextContent(entry).includes('<orchestration-handoff>')
  })
  if (bootstrapIndex < 0) return runtime.entries
  return runtime.entries.slice(bootstrapIndex)
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
  const latestTimestamp = [...messages].reverse().find(message => message.timestamp)?.timestamp
  const parsed = latestTimestamp ? Date.parse(latestTimestamp) : NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

function boundedMaxMessages(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_MESSAGES
  if (!Number.isFinite(value)) return DEFAULT_MAX_MESSAGES
  return Math.max(1, Math.min(100, Math.floor(value)))
}
