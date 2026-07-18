import type { ToolUseBlock } from '@shared/types/transcript'
import {
  fromAgentCodeOrchestrationUse,
  type AgentCodeOrchestrationOperation,
  type AgentCodeOrchestrationUseModel,
} from '@providers/shared/renderer/protocols/agent-code-orchestration/model'

const OPERATIONS: Record<string, AgentCodeOrchestrationOperation> = {
  orchestration_create_agent: 'create-agent',
  orchestration_send_prompt: 'send-prompt',
  orchestration_list_agents: 'list-agents',
  orchestration_read_agent: 'read-agent',
  orchestration_read_run_outputs: 'read-run-outputs',
  orchestration_wait_agents: 'wait-agents',
  orchestration_close_agent: 'close-agent',
  orchestration_close_run: 'close-run',
}

// WHY the owned adapter knows one operation that the Claude catalog does not
// yet list: `orchestration_read_run_outputs` is part of Agent Code's
// source-controlled MCP contract, but the current Claude recording corpus has
// not produced a trustworthy render-shape fingerprint for it. Supporting the
// exact namespace is safe because the model still validates the operation's
// input/result schema and declines malformed data; inventing a catalog entry or
// fixture would not be. TODO(agent-code-mcp-evidence): add the Claude shape only
// after a real semantic or committed sighting has been captured.

export function fromClaudeAgentCodeOrchestrationUse(
  block: ToolUseBlock,
): AgentCodeOrchestrationUseModel | null {
  // WHY require the exact built-in server namespace: MCP tool names are open
  // world. Another server may expose an `orchestration_create_agent` with an
  // unrelated schema, and Phase 7 explicitly promises it the generic JSON
  // fallback instead of a confident but false Agent Code card.
  const match = /^mcp__agent_code__(orchestration_[a-z_]+)$/.exec(block.name)
  if (!match) return null
  const operation = OPERATIONS[match[1]]
  return operation ? fromAgentCodeOrchestrationUse(block, operation) : null
}
