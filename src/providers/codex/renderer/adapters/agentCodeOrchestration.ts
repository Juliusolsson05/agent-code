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

export function fromCodexAgentCodeOrchestrationUse(
  block: ToolUseBlock,
): AgentCodeOrchestrationUseModel | null {
  // Historical Codex rollouts stripped the MCP server prefix and committed
  // these exact bare names. This mapping is therefore provider-local evidence,
  // not a shared claim that every provider's bare orchestration verb belongs to
  // Agent Code. Current Codex invokes MCP through a unified `exec` cell instead;
  // those rows deliberately stay commands and only pretty-format their nested
  // CallToolResult. TODO(agent-code-mcp-provenance): do not absorb that newer
  // carrier here until the transcript provides a stable direct tool identity
  // and result join key rather than merely executable source text.
  const operation = OPERATIONS[block.name]
  return operation ? fromAgentCodeOrchestrationUse(block, operation) : null
}
