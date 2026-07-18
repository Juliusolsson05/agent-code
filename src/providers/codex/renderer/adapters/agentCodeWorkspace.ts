import {
  fromAgentCodeWorkspaceUse,
  isAgentCodeWorkspaceTool,
} from '@providers/shared/renderer/protocols/agent-code-workspace/model'
import type { ToolUseBlock } from '@shared/types/transcript'

// Historical Codex built-in MCP calls arrive with the server namespace
// stripped; the frozen corpus proves these exact bare names. Do not admit
// fuzzy workspace-like names—the generic fallback is the open-world path.
export function fromCodexAgentCodeWorkspaceUse(block: ToolUseBlock) {
  if (!isAgentCodeWorkspaceTool(block.name)) return null
  return fromAgentCodeWorkspaceUse(block, block.name)
}
