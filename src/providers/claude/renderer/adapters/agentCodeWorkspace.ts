import {
  fromAgentCodeWorkspaceUse,
  isAgentCodeWorkspaceTool,
} from '@providers/shared/renderer/protocols/agent-code-workspace/model'
import type { ToolUseBlock } from '@shared/types/transcript'

// Claude exposes MCP ownership in the tool name. Only the exact Agent Code
// namespace may reach the source-controlled workspace protocol; an external
// server exporting `ai_workspace_create` remains generic and fully visible.
//
// TODO(agent-code-workspace-claude-fixture): the frozen corpus currently proves
// the Codex bare-name generation, not a Claude invocation/result pair. This
// adapter is still justified because the `mcp__agent_code__` namespace and the
// Agent Code MCP implementation are source-controlled contracts, but do not
// loosen its namespace or add Claude-only field interpretation until a real
// capture supplies the paired wire evidence. The shared model must continue to
// decline malformed input so an upstream namespace collision stays generic.
export function fromClaudeAgentCodeWorkspaceUse(block: ToolUseBlock) {
  const match = /^mcp__agent_code__(ai_workspace_.+)$/.exec(block.name)
  if (!match || !isAgentCodeWorkspaceTool(match[1])) return null
  return fromAgentCodeWorkspaceUse(block, match[1])
}
