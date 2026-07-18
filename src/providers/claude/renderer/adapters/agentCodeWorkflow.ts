import type { ToolUseBlock } from '@shared/types/transcript'
import { fromAgentCodeWorkflowUse } from '@providers/shared/renderer/protocols/agent-code-workflow/model'

// TODO(agent-code-workflow-capture): no checked-in rendering bundle currently
// contains Workflow MCP traffic. We admit only these two source-controlled
// Agent Code names and validate their required schema in the shared protocol;
// every other workflow-looking MCP tool remains generic. Replace this comment
// with linked invocation/result/replay fixtures before adding progress phases,
// coverage summaries, or any result absorption beyond parseWorkflowToolResult.
export function fromClaudeAgentCodeWorkflowUse(block: ToolUseBlock) {
  if (block.name === 'mcp__agent_code__workflow_run') {
    return fromAgentCodeWorkflowUse(block, 'workflow_run')
  }
  if (block.name === 'mcp__agent_code__workflow_resume') {
    return fromAgentCodeWorkflowUse(block, 'workflow_resume')
  }
  return null
}
