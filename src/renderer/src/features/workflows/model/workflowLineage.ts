import type { WorkflowState } from 'workflow-mcp/state'

type WorkflowAgent = WorkflowState['agents'][number]
type WorkflowAttempt = WorkflowAgent['attempts'][number]

function lineageAttempt(runId: string, attempt: WorkflowAttempt): WorkflowAttempt {
  // Attempt and activity IDs are only unique inside one run. Namespacing the attempt lets the UI
  // retain `attempt_1/item_0` from several resumptions without React mistaking old tool calls for
  // updates to the current attempt. The provider-facing IDs never leave their immutable snapshot.
  return { ...attempt, id: `${runId}:${attempt.id}` }
}

function lineageAgent(runId: string, agent: WorkflowAgent): WorkflowAgent {
  return {
    ...agent,
    id: `${runId}:${agent.id}`,
    attempts: agent.attempts.map(attempt => lineageAttempt(runId, attempt)),
  }
}

function deriveCounts(agents: WorkflowAgent[]): WorkflowState['counts'] {
  const counts: WorkflowState['counts'] = {
    total: agents.length,
    admitted: 0,
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    reused: 0,
    attempts: 0,
  }
  for (const agent of agents) {
    counts[agent.status] += 1
    counts.attempts += agent.attempts.length
    if (agent.outcome?.source === 'journal') counts.reused += 1
  }
  return counts
}

/**
 * Project immutable resume attempts as one logical workflow for the inspector.
 *
 * WHY agents join by cacheKey instead of agent ID or label: IDs restart at `agent_1` for every
 * durable run and labels are presentation-only/non-unique. The journal cache key commits to the
 * preceding call chain, prompt, and normalized options; it is the execution runtime's own identity
 * for deciding that a child call is the same logical work as its parent. A matching child supplies
 * current status/outcome while prior attempts remain available as conversation and tool history.
 */
export function mergeWorkflowLineage(
  history: readonly WorkflowState[],
  current: WorkflowState,
): WorkflowState {
  if (history.length === 0) return current

  const agentsByKey = new Map<string, WorkflowAgent>()
  const order: string[] = []
  for (const state of [...history, current]) {
    for (const sourceAgent of state.agents) {
      const previous = agentsByKey.get(sourceAgent.cacheKey)
      const next = lineageAgent(state.runId, sourceAgent)
      if (!previous) {
        agentsByKey.set(sourceAgent.cacheKey, next)
        order.push(sourceAgent.cacheKey)
        continue
      }

      // The newest logical agent owns state, errors, and results. Only the attempt history and the
      // earliest admission/start timestamps cross the boundary; carrying a parent's cancelled
      // status into a running child would make the inspector lie about execution.
      agentsByKey.set(sourceAgent.cacheKey, {
        ...next,
        id: sourceAgent.id,
        admittedAt: previous.admittedAt,
        ...(previous.startedAt === undefined ? {} : { startedAt: previous.startedAt }),
        attempts: [...previous.attempts, ...next.attempts],
      })
    }
  }

  const agents = order
    .map(key => agentsByKey.get(key))
    .filter((agent): agent is WorkflowAgent => agent !== undefined)
    .sort((left, right) => left.callIndex - right.callIndex)

  return {
    ...current,
    agents,
    counts: deriveCounts(agents),
    // These collections are not all rendered today, but retaining them here keeps the composed
    // state honest for future log/artifact panels instead of silently reintroducing the same bug.
    logs: history.flatMap(state => state.logs).concat(current.logs),
    warnings: history.flatMap(state => state.warnings).concat(current.warnings),
    artifacts: history.flatMap(state => state.artifacts).concat(current.artifacts),
  }
}
